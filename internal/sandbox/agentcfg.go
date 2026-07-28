package sandbox

import (
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"

	"braces.dev/errtrace"
	toml "github.com/pelletier/go-toml/v2"
	"github.com/trolleyman/hydra/internal/gate"
)

// This file holds the per-agent configuration generators (moved from the old
// internal/docker package). They produce the settings/hooks JSON that registers
// Hydra's status hooks and pre-accepts trust dialogs. The seeding orchestration
// (writing files + building Binds) lives in internal/heads.

// hookHandler is a single hook handler entry in a hooks settings.json.
type hookHandler struct {
	Type    string `json:"type"`
	Command string `json:"command"`
}

// matcherGroup is a matcher group (with optional matcher) in a hooks settings.json.
type matcherGroup struct {
	Hooks []hookHandler `json:"hooks"`
}

// buildHooksMap constructs a hooks map from a list of event names, all sharing the same command.
func buildHooksMap(cmd string, events []string) map[string]interface{} {
	group := []matcherGroup{{Hooks: []hookHandler{{Type: "command", Command: cmd}}}}
	m := make(map[string]interface{}, len(events))
	for _, event := range events {
		m[event] = group
	}
	return m
}

// HookCommand returns the shell command a hook runs to report status back to
// Hydra, invoking the hydra binary at hydraBin (its real host path, visible
// inside the sandbox via the read-only root bind).
func HookCommand(hydraBin, agent string) string {
	return shellQuote(hydraBin) + " trigger-hook " + agent
}

// GateCommand returns the shell command the decision-capable PreToolUse gate
// runs (a second PreToolUse hook alongside HookCommand). A gate "deny" blocks
// the tool even under --dangerously-skip-permissions.
func GateCommand(hydraBin, agent string) string {
	return shellQuote(hydraBin) + " gate " + agent
}

// shellQuote single-quotes s for safe embedding in a hook command string.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// ClaudeManagedSettingsDir / ClaudeManagedSettingsPath are the system managed-
// settings location Claude Code reads on Linux. Managed settings are the highest-
// precedence scope and cannot be overridden: hooks defined here keep running even
// if a writable user/project settings.json sets "disableAllHooks": true - which is
// why Hydra's gate hook lives here, not in a (defeatable) read-only user
// settings.json. The dir is overlaid with a tmpfs and the file bound read-only.
const (
	ClaudeManagedSettingsDir  = "/etc/claude-code"
	ClaudeManagedSettingsPath = "/etc/claude-code/managed-settings.json"
)

// BuildClaudeSettings generates the settings.json content with hook configuration
// for Claude Code. When gateEnabled, a second PreToolUse hook (`hydra gate`) is
// registered alongside the status hook so the trusted policy can deny tool calls.
// mcpAllowed is the MCP server allow-list: only those project-scoped .mcp.json
// servers are enabled (so allow-listed ones load without the interactive trust
// prompt Hydra can't answer headless), and project auto-trust is turned off so
// everything else stays inert.
func BuildClaudeSettings(existing []byte, hydraBin string, gateEnabled bool, mcpAllowed []string) ([]byte, error) {
	statusCmd := HookCommand(hydraBin, "claude")
	hooks := buildHooksMap(statusCmd, []string{
		"SessionStart",
		"UserPromptSubmit",
		"PostToolUse",
		"PostToolUseFailure",
		"PermissionRequest",
		"Notification",
		"Stop",
		"PreCompact",
		"SubagentStart",
		"SubagentStop",
		"SessionEnd",
	})
	// PreToolUse runs the status hook AND, when enabled, the decision gate. Both
	// share one matcher group; Claude runs every hook and any "deny" wins.
	preToolHooks := []hookHandler{{Type: "command", Command: statusCmd}}
	if gateEnabled {
		preToolHooks = append(preToolHooks, hookHandler{Type: "command", Command: GateCommand(hydraBin, "claude")})
	}
	hooks["PreToolUse"] = []matcherGroup{{Hooks: preToolHooks}}
	// The gate also runs after the fact, where it adds context rather than
	// decisions - it is what lets the read-only .git redirect be advice instead of
	// a deny that costs the whole Bash call (see cli.emitPostAdvice). It stays
	// silent for everything else.
	if gateEnabled {
		gateGroup := matcherGroup{Hooks: []hookHandler{{Type: "command", Command: GateCommand(hydraBin, "claude")}}}
		for _, event := range []string{"PostToolUse", "PostToolUseFailure"} {
			// buildHooksMap hands every event the SAME backing slice, so append to a
			// copy - appending in place would leak this hook into sibling events.
			existing, _ := hooks[event].([]matcherGroup)
			hooks[event] = append(append([]matcherGroup{}, existing...), gateGroup)
		}
	}

	settings := make(map[string]interface{})
	if len(existing) > 0 {
		if err := json.Unmarshal(existing, &settings); err != nil {
			log.Printf("warn: failed to unmarshal existing claude settings: %v", err)
		}
	}

	settings["skipDangerousModePermissionPrompt"] = true
	settings["hooks"] = hooks
	settings["enableAllProjectMcpServers"] = false
	settings["enabledMcpjsonServers"] = append([]string{}, mcpAllowed...)

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal claude settings: %w", err))
	}
	return data, nil
}

// BuildClaudeConfig generates the .claude.json content with project trust
// settings, and strips any MCP server (user-scope or per-project) not on
// mcpAllowed so non-allow-listed servers never spawn (a stdio MCP server is code
// that runs the moment the session starts, so gating tool calls alone is too
// late). It also injects the Hydra control server (`hydraBin mcp <agentType>`)
// AFTER stripping, so the agent always has the discover/request tools.
func BuildClaudeConfig(existing []byte, worktreePath string, mcpAllowed []string, hydraBin, agentType string) ([]byte, error) {
	cfg := make(map[string]interface{})
	if len(existing) > 0 {
		if err := json.Unmarshal(existing, &cfg); err != nil {
			log.Printf("warn: failed to unmarshal existing claude config: %v", err)
		}
	}

	projects, _ := cfg["projects"].(map[string]interface{})
	if projects == nil {
		projects = make(map[string]interface{})
	}
	project, _ := projects[worktreePath].(map[string]interface{})
	if project == nil {
		project = make(map[string]interface{})
	}
	project["hasTrustDialogAccepted"] = true
	projects[worktreePath] = project
	cfg["projects"] = projects

	stripMCPServers(cfg, mcpAllowed)

	// Inject the Hydra control server after stripping so it is always present.
	if hydraBin != "" {
		servers, _ := cfg["mcpServers"].(map[string]interface{})
		if servers == nil {
			servers = make(map[string]interface{})
		}
		name, command, args := HydraMCPServer(hydraBin, agentType)
		servers[name] = map[string]interface{}{"type": "stdio", "command": command, "args": args}
		cfg["mcpServers"] = servers
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal claude config: %w", err))
	}
	return data, nil
}

// stripMCPServers removes every MCP server not on allowed from the seeded
// ~/.claude.json - both the top-level user-scope `mcpServers` map and any
// per-project `projects[*].mcpServers` map. Server names are matched
// case-sensitively (MCP names are case-sensitive).
func stripMCPServers(cfg map[string]interface{}, allowed []string) {
	allow := make(map[string]bool, len(allowed))
	for _, a := range allowed {
		allow[a] = true
	}
	prune := func(container map[string]interface{}) {
		servers, ok := container["mcpServers"].(map[string]interface{})
		if !ok {
			return
		}
		for name := range servers {
			if !allow[name] {
				delete(servers, name)
			}
		}
	}
	prune(cfg)
	if projects, ok := cfg["projects"].(map[string]interface{}); ok {
		for _, p := range projects {
			if pm, ok := p.(map[string]interface{}); ok {
				prune(pm)
			}
		}
	}
}

// MCPServer names a candidate MCP server discovered in the host/project config.
// It is the unit the allow-list (mcp_allowed) selects from.
type MCPServer struct {
	// Name is the server key as it appears under mcpServers.
	Name string `json:"name"`
	// Source is where it was found: "user" (host ~/.claude.json) or "project"
	// (the project .mcp.json or a projects[*].mcpServers entry).
	Source string `json:"source"`
}

// ListMCPServers enumerates candidate MCP servers from the host ~/.claude.json
// (top-level user-scope mcpServers plus any projects[*].mcpServers) and a project
// .mcp.json ({"mcpServers": {...}}). It returns a de-duplicated, name-sorted list;
// a server seen in more than one place is reported once, preferring source
// "user". Malformed JSON yields no servers from that source (best-effort).
func ListMCPServers(claudeJSON, mcpJSON []byte) []MCPServer {
	found := map[string]string{} // name -> source
	add := func(name, source string) {
		if name == "" {
			return
		}
		// "user" wins over "project" when a name appears in both.
		if existing, ok := found[name]; ok && existing == "user" {
			return
		}
		found[name] = source
	}
	names := func(container map[string]interface{}) []string {
		servers, ok := container["mcpServers"].(map[string]interface{})
		if !ok {
			return nil
		}
		out := make([]string, 0, len(servers))
		for name := range servers {
			out = append(out, name)
		}
		return out
	}

	if len(claudeJSON) > 0 {
		var cfg map[string]interface{}
		if json.Unmarshal(claudeJSON, &cfg) == nil {
			for _, n := range names(cfg) {
				add(n, "user")
			}
			if projects, ok := cfg["projects"].(map[string]interface{}); ok {
				for _, p := range projects {
					if pm, ok := p.(map[string]interface{}); ok {
						for _, n := range names(pm) {
							add(n, "project")
						}
					}
				}
			}
		}
	}
	if len(mcpJSON) > 0 {
		var cfg map[string]interface{}
		if json.Unmarshal(mcpJSON, &cfg) == nil {
			for _, n := range names(cfg) {
				add(n, "project")
			}
		}
	}

	out := make([]MCPServer, 0, len(found))
	for name, source := range found {
		out = append(out, MCPServer{Name: name, Source: source})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// MCPServerSpec is a stdio MCP server's launch command, used to introspect its
// tools (read/write annotations). Non-stdio servers have an empty Command.
type MCPServerSpec struct {
	Name    string
	Command string
	Args    []string
	Env     map[string]string
}

// MCPServerSpecs extracts stdio launch specs for the named servers from the host
// ~/.claude.json (top-level mcpServers + projects[*].mcpServers) and a project
// .mcp.json. Servers with no command (http/sse transports) or not in names are
// skipped. The first spec found for a name wins.
func MCPServerSpecs(claudeJSON, mcpJSON []byte, names []string) []MCPServerSpec {
	want := make(map[string]bool, len(names))
	for _, n := range names {
		want[n] = true
	}
	seen := map[string]bool{}
	var out []MCPServerSpec

	consume := func(container map[string]interface{}) {
		servers, ok := container["mcpServers"].(map[string]interface{})
		if !ok {
			return
		}
		for name, raw := range servers {
			if !want[name] || seen[name] {
				continue
			}
			m, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			command, _ := m["command"].(string)
			if command == "" {
				continue // non-stdio (http/sse) - can't spawn to introspect
			}
			spec := MCPServerSpec{Name: name, Command: command}
			if rawArgs, ok := m["args"].([]interface{}); ok {
				for _, a := range rawArgs {
					if s, ok := a.(string); ok {
						spec.Args = append(spec.Args, s)
					}
				}
			}
			if rawEnv, ok := m["env"].(map[string]interface{}); ok {
				spec.Env = map[string]string{}
				for k, v := range rawEnv {
					if s, ok := v.(string); ok {
						spec.Env[k] = s
					}
				}
			}
			seen[name] = true
			out = append(out, spec)
		}
	}

	for _, data := range [][]byte{claudeJSON, mcpJSON} {
		if len(data) == 0 {
			continue
		}
		var cfg map[string]interface{}
		if json.Unmarshal(data, &cfg) != nil {
			continue
		}
		consume(cfg)
		if projects, ok := cfg["projects"].(map[string]interface{}); ok {
			for _, p := range projects {
				if pm, ok := p.(map[string]interface{}); ok {
					consume(pm)
				}
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// BuildGeminiSettings generates the settings.json content with hook configuration for Gemini CLI.
func BuildGeminiSettings(existing []byte, hydraBin string) ([]byte, error) {
	hooks := buildHooksMap(HookCommand(hydraBin, "gemini"), []string{
		"SessionStart",
		"BeforeAgent",
		"AfterAgent",
		"BeforeTool",
		"AfterTool",
		"Notification",
		"PreCompress",
		"SessionEnd",
	})

	settings := make(map[string]interface{})
	if len(existing) > 0 {
		if err := json.Unmarshal(existing, &settings); err != nil {
			log.Printf("warn: failed to unmarshal existing gemini settings: %v", err)
		}
	}

	settings["hooks"] = hooks

	// The Hydra control MCP server (git_* tools + MCP discovery), so Gemini heads
	// get the same tools as Claude. Gemini's settings.json uses the same mcpServers
	// shape (name -> {command, args}); merge into any existing map.
	if hydraBin != "" {
		servers, _ := settings["mcpServers"].(map[string]interface{})
		if servers == nil {
			servers = make(map[string]interface{})
		}
		name, command, args := HydraMCPServer(hydraBin, "gemini")
		servers[name] = map[string]interface{}{"command": command, "args": args}
		settings["mcpServers"] = servers
	}

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal gemini settings: %w", err))
	}
	return data, nil
}

// HydraMCPServer returns the name and stdio launch spec (command + args) of the
// in-sandbox Hydra control MCP server - the single source of truth every agent's
// config seeds, so the git_* tools and MCP discovery/request tools are available
// regardless of agent type. Each agent's builder renders this into its own config
// format (Claude/Gemini JSON mcpServers, Codex TOML [mcp_servers]).
func HydraMCPServer(hydraBin, agentType string) (name, command string, args []string) {
	return gate.HydraControlServer, hydraBin, []string{"mcp", agentType}
}

// HydraBinPath is the well-known path the hydra binary is bound to inside every
// sandbox. /tmp is always a fresh, per-head writable mount in our bwrap config (a
// private host-backed dir on Linux, else a tmpfs - see Options.TmpDir), so it is a
// reliable mountpoint and the seeded binds nest on top of it. Hooks, the
// namespace-host supervisor and the control MCP server are all invoked here.
const HydraBinPath = "/tmp/hydra-internal"

// claudeMCPConfigArgs renders the Hydra control server as a `--mcp-config` flag,
// so Claude learns about it from its own argv rather than from a file.
//
// The server is ALSO written into the seeded ~/.claude.json (BuildClaudeConfig),
// but that file is bind-mounted over the host's real one, and a bind mount on a
// FILE only survives as long as the path keeps pointing at the same dentry: the
// moment anything on the host replaces ~/.claude.json by rename() - which is
// exactly how Claude Code saves its own config - the mount is dropped from every
// running head's sandbox, silently. The sandbox then falls through to the host's
// ~/.claude.json, which declares no hydra server, and any Claude that starts (or
// re-reads its config) after that comes up with NO hydra tools: no connection
// attempt, no error, and no recovery for the rest of the session. That was
// roughly half of all resumes/restarts. argv can't be swapped out from under us.
//
// Declaring the same server in both places is additive, not a conflict - it
// resolves to a single connection (spike-verified against the CLI).
func claudeMCPConfigArgs(agentType string) []string {
	name, command, args := HydraMCPServer(HydraBinPath, agentType)
	data, err := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			name: map[string]any{"type": "stdio", "command": command, "args": args},
		},
	})
	if err != nil {
		// The value is built here from constants, so this cannot fail; if it ever
		// did, dropping the flag leaves the seeded-config path as it was.
		return nil
	}
	return []string{"--mcp-config", string(data)}
}

// AgentSupportsGitTools reports whether the agent type gets the Hydra control MCP
// server (and thus the git_* tools) seeded - the set seedHead seeds it for
// (claude/codex/gemini). Only these can commit under git_isolation=readonly, where
// .git is read-only in the sandbox and raw git can't write it; agents without the
// tools would be stuck unable to commit, so readonly falls back to off for them.
func AgentSupportsGitTools(a AgentType) bool {
	switch a {
	case AgentTypeClaude, AgentTypeCodex, AgentTypeGemini:
		return true
	}
	return false
}

// BuildCopilotHooks generates a hooks JSON file for GitHub Copilot CLI.
// Copilot CLI loads hooks from .github/hooks/*.json in the working directory.
// The format differs from Claude/Gemini: it uses {"version":1,"hooks":{...}}.
func BuildCopilotHooks(hydraBin string) ([]byte, error) {
	type hookEntry struct {
		Type string `json:"type"`
		Bash string `json:"bash"`
	}
	type hooksFile struct {
		Version int                    `json:"version"`
		Hooks   map[string][]hookEntry `json:"hooks"`
	}

	cmd := shellQuote(hydraBin) + " trigger-hook copilot"
	hf := hooksFile{
		Version: 1,
		Hooks: map[string][]hookEntry{
			"sessionStart":        {{Type: "command", Bash: cmd + " sessionStart"}},
			"userPromptSubmitted": {{Type: "command", Bash: cmd + " userPromptSubmitted"}},
			"preToolUse":          {{Type: "command", Bash: cmd + " preToolUse"}},
			"postToolUse":         {{Type: "command", Bash: cmd + " postToolUse"}},
			"sessionEnd":          {{Type: "command", Bash: cmd + " sessionEnd"}},
		},
	}

	data, err := json.MarshalIndent(hf, "", "  ")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal copilot hooks: %w", err))
	}
	return data, nil
}

// BuildCodexHooks merges Hydra's lifecycle observer into the user's Codex
// hooks.json. Matching groups are appended because Codex runs every match and
// Hydra's observer should not replace personal hooks.
func BuildCodexHooks(existing []byte, hydraBin string) ([]byte, error) {
	type hooksFile struct {
		Description string                       `json:"description,omitempty"`
		Hooks       map[string][]json.RawMessage `json:"hooks"`
	}
	var file hooksFile
	if len(existing) > 0 {
		if err := json.Unmarshal(existing, &file); err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("unmarshal codex hooks: %w", err))
		}
	}
	if file.Hooks == nil {
		file.Hooks = map[string][]json.RawMessage{}
	}
	group, err := json.Marshal(matcherGroup{Hooks: []hookHandler{{Type: "command", Command: HookCommand(hydraBin, "codex")}}})
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	for _, event := range []string{
		"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
		"PermissionRequest", "Stop", "SubagentStart", "SubagentStop",
	} {
		file.Hooks[event] = append(file.Hooks[event], json.RawMessage(group))
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal codex hooks: %w", err))
	}
	return data, nil
}

// BuildCodexConfig merges the Hydra control MCP server into the user's Codex
// config.toml (`[mcp_servers.hydra]`), preserving everything else (model, auth,
// etc.). Codex reads MCP servers from ~/.codex/config.toml. A malformed host
// config is a hard error so the caller can skip seeding rather than clobber it.
func BuildCodexConfig(existing []byte, hydraBin string) ([]byte, error) {
	cfg := map[string]interface{}{}
	if len(existing) > 0 {
		if err := toml.Unmarshal(existing, &cfg); err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("unmarshal codex config: %w", err))
		}
	}
	servers, _ := cfg["mcp_servers"].(map[string]interface{})
	if servers == nil {
		servers = map[string]interface{}{}
	}
	name, command, args := HydraMCPServer(hydraBin, "codex")
	servers[name] = map[string]interface{}{"command": command, "args": args}
	cfg["mcp_servers"] = servers

	data, err := toml.Marshal(cfg)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal codex config: %w", err))
	}
	return data, nil
}

// AgentArgv returns the command line to run inside the sandbox for the given
// agent type. resume runs the agent's own resume flow (continuing the prior
// conversation, so no task prompt is passed); otherwise prompt (if non-empty)
// is passed as the task. The permission-bypass mode flag
// (--dangerously-skip-permissions / --approval-mode=yolo / --yolo) is applied in
// BOTH cases - a resumed agent must stay non-interactive.
//
// systemPrompt holds the standing Hydra instructions, delivered as a system
// prompt, never as part of the user's task: Claude takes them via
// --append-system-prompt (applied on resume too). Gemini, Copilot and Codex have
// no such flag, so for them the instructions are seeded as context files (see
// seedHead, which also runs on resume) and systemPrompt is ignored here.
// AgentArgv builds the command line for an agent CLI. model, when non-empty, is
// passed as the CLI's --model flag but ONLY on a fresh spawn (resume == false):
// on resume the flag is omitted so the agent restores whatever model its
// transcript was saved with and honours any in-session model change (e.g.
// Claude's /model). Forcing --model on resume would override that and, because
// each model has its own prompt cache, trigger a full cache-missing re-read of
// the conversation. Empty model inherits the CLI's own default.
//
// chatMode drives Claude or Codex through its structured protocol
// interface instead of the interactive TUI: the process stays alive reading
// user turns from stdin, and the task prompt is sent as the first stdin
// message (see SpawnHead) rather than as argv.
//
// resumeSessionID (Claude only) resumes that exact conversation with
// --resume <id> instead of --continue. Load-bearing for the chat->terminal
// mode toggle: the interactive TUI's --continue skips conversations recorded
// by -p/stream-json runs ("No conversation found to continue",
// spike-verified), while an explicit --resume <id> loads them fine. Callers
// pass the newest non-sidechain transcript's id
// (claudestream.LatestSessionID); empty falls back to --continue.
func AgentArgv(agentType AgentType, resume bool, systemPrompt, prompt, model string, chatMode bool, resumeSessionID string) ([]string, error) {
	if chatMode && agentType != AgentTypeClaude && agentType != AgentTypeCodex {
		return nil, errtrace.Wrap(fmt.Errorf("chat mode is only supported for claude and codex agents, not %q", agentType))
	}
	switch agentType {
	case AgentTypeClaude:
		argv := []string{"claude", "--dangerously-skip-permissions"}
		// --mcp-config is VARIADIC (it takes space-separated configs), so it eats
		// every following non-flag token: `--mcp-config <json> mcp list` reads
		// "mcp" and "list" as two more config paths. It goes here, at the front,
		// where everything that can follow is a flag, `--`, or nothing at all.
		argv = append(argv, claudeMCPConfigArgs(string(agentType))...)
		if systemPrompt != "" {
			argv = append(argv, "--append-system-prompt", systemPrompt)
		}
		if !resume && model != "" {
			argv = append(argv, "--model", model)
		}
		resumeArgs := func() []string {
			if resumeSessionID != "" {
				return []string{"--resume", resumeSessionID}
			}
			return []string{"--continue"}
		}
		if chatMode {
			// stream-json output requires --verbose in -p mode.
			// --replay-user-messages echoes stdin user turns back onto stdout,
			// so the session scrollback ring alone reconstructs the recent
			// conversation for a freshly-attached chat client (older history is
			// backfilled from the transcript file, see chat_ws.go).
			// --include-partial-messages adds stream_event token deltas for
			// live streaming; those are filtered OUT of the scrollback ring
			// (session.RingFilter) so replay stays compact.
			// --permission-prompt-tool stdio is what exposes AskUserQuestion
			// headless: the tool call arrives as a can_use_tool
			// control_request the chat client answers over the socket. It
			// composes with --dangerously-skip-permissions - everything not
			// requiring user interaction is auto-allowed without a
			// control_request (spike-verified).
			argv = append(argv,
				"-p",
				"--input-format", "stream-json",
				"--output-format", "stream-json",
				"--verbose",
				"--replay-user-messages",
				"--include-partial-messages",
				"--permission-prompt-tool", "stdio",
			)
			if resume {
				argv = append(argv, resumeArgs()...)
			}
			return argv, nil
		}
		if resume {
			// Explicit --resume <id> when the transcript is known (see above);
			// bare --continue otherwise. A bare --resume would pop an
			// interactive session picker that exits the process if cancelled.
			return append(argv, resumeArgs()...), nil
		}
		if prompt != "" {
			argv = append(argv, "--", prompt)
		}
		return argv, nil
	case AgentTypeGemini:
		argv := []string{"gemini", "--approval-mode=yolo"}
		if !resume && model != "" {
			argv = append(argv, "--model", model)
		}
		if resume {
			// "latest" resumes the most recent session non-interactively.
			return append(argv, "--resume", "latest"), nil
		}
		if prompt != "" {
			argv = append(argv, "-i", prompt)
		}
		return argv, nil
	case AgentTypeCopilot:
		argv := []string{"copilot", "--yolo"}
		if !resume && model != "" {
			argv = append(argv, "--model", model)
		}
		if resume {
			return append(argv, "--resume"), nil
		}
		if prompt != "" {
			argv = append(argv, "--autopilot", "-p", prompt)
		}
		return argv, nil
	case AgentTypeCodex:
		// Codex already provides its own OS sandbox + approval prompts; since we
		// run it inside Hydra's sandbox we disable both with the explicit
		// "externally sandboxed" escape hatch (the analog of
		// --dangerously-skip-permissions). Codex has no --append-system-prompt
		// flag, so the pre-prompt is seeded as ~/.codex/AGENTS.md (see seedHead)
		// and systemPrompt is ignored here.
		if chatMode {
			// app-server is Codex's persistent bidirectional rich-client
			// protocol. Approval/sandbox policy is supplied on thread/start by the
			// controller; Hydra's outer sandbox remains the enforcement boundary.
			return []string{"codex", "--dangerously-bypass-hook-trust", "--enable", "default_mode_request_user_input", "app-server", "--listen", "stdio://"}, nil
		}
		argv := []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"}
		if !resume && model != "" {
			argv = append(argv, "--model", model)
		}
		if resume {
			// `resume --last` continues the most recent recorded session in this
			// cwd without the interactive session picker.
			return append(argv, "resume", "--last"), nil
		}
		if prompt != "" {
			// The task is Codex's positional [PROMPT] argument.
			argv = append(argv, prompt)
		}
		return argv, nil
	case AgentTypeBash:
		return []string{"/bin/bash"}, nil
	default:
		return nil, errtrace.Wrap(fmt.Errorf("unknown agent type: %q", agentType))
	}
}
