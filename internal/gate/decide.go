package gate

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// HydraControlServer is the reserved name of the always-present MCP server Hydra
// seeds into the agent's config (the discover/request-MCP-server tools). It is
// auto-allowed by the gate and never stripped from the seeded config.
const HydraControlServer = "hydra"

// Decision is the gate's verdict for a single tool call.
type Decision string

const (
	// Allow lets the tool proceed (the hook emits nothing - silence = proceed).
	Allow Decision = "allow"
	// Deny blocks the tool; the hook emits a permissionDecision: "deny".
	Deny Decision = "deny"
	// Ask parks the head for user approval; the hook blocks on a decision file.
	Ask Decision = "ask"
)

// Result is Decide's verdict plus the context the hook surfaces to the user (in
// the approval card and the deny message) and persists for a remembered approval.
type Result struct {
	Decision Decision
	// Reason is a one-line human explanation, shown in the deny message / card.
	Reason string
	// Kind classifies an Ask so a remembered approval knows what to persist:
	// "mcp" (Target is the server name), "mcp_tool" (Target is "<server>__<tool>"),
	// or "webfetch" (Target is the host).
	Kind string
	// Target is the server/host/tool an Ask is about (for the approval UI + remember).
	Target string
	// RW is the read/write classification of an MCP tool call ("read", "write", or
	// "" when not applicable/unknown), surfaced as a badge on the approval card.
	RW string
	// URL is the full request URL for a WebFetch ask (the approval card previews it).
	URL string
	// ArgsPreview is a compact one-line preview of an MCP tool call's arguments
	// (the approval card shows it under the tool name).
	ArgsPreview string
}

// globalInstallRe matches Bash commands that install system- or user-global
// software, which the pre-prompt forbids. It is a deliberate tripwire, not an
// airtight boundary (a determined agent can re-encode a command) - the real
// network boundary is the egress proxy; this just enforces the stated rule on
// the common, honest spelling.
var globalInstallRe = regexp.MustCompile(`(?i)\b(` +
	`apt(-get)?\s+(install|remove|purge)|` +
	`dnf\s+install|yum\s+install|pacman\s+-S|apk\s+add|` +
	`brew\s+(install|upgrade)|` +
	`npm\s+(i|install|add)\b[^|&;]*\s-g\b|npm\s+(i|install|add)\b[^|&;]*--global|` +
	`pnpm\s+add\b[^|&;]*\s-g\b|yarn\s+global\s+add|` +
	`pip\s+install\b[^|&;]*\s--user\b|` +
	`go\s+install\b|cargo\s+install\b|` +
	`sudo\b` +
	`)`)

// gitPushRe matches an actual `git push` INVOCATION: `git` at a command boundary
// (start of the line, or right after a `;`, `&`, `|`, `(`, or newline) followed
// by `push`, tolerating global flags (`git -c x=y push`) in between. Anchoring to
// the command position is deliberate - the bare substring "git push" also shows
// up inside an argument, a quoted grep pattern, or a commit message, and matching
// those would hard-deny a perfectly legitimate command. `--dry-run` is excluded
// by the caller.
var gitPushRe = regexp.MustCompile(`(?i)(?:^|[\n;&|(])\s*git\s+(?:-[^\s]+\s+)*push\b`)

// procKillRe matches a `pkill` or `killall` INVOCATION at a command boundary
// (start, or right after a `;`, `&`, `|`, `(`, or newline), tolerating a leading
// `sudo`. These kill processes by NAME/command-line pattern, and every agent runs
// as `claude --append-system-prompt "<the whole system prompt>"`, so that argv
// contains most words an agent might pkill on (e.g. a leftover dev server whose
// name also appears in the prompt) - a generic pattern silently matches the
// agent's own process and any co-tenant sessions sharing the head's PID namespace,
// killing the session mid-command. Anchoring to the command position (like
// gitPushRe) keeps a bare mention in an argument, echo, or grep pattern from
// tripping. Kill-by-PID (`kill "$PID"`) and job specs are unaffected.
var procKillRe = regexp.MustCompile(`(?i)(?:^|[\n;&|(])\s*(?:sudo\s+)?(?:pkill|killall)\b`)

// gitCommitRe matches a `git commit` invocation at a command boundary. Like
// gitPushRe it skips leading flags, but it also skips a `-c KEY=VAL` config pair
// (a separate-arg value, e.g. `git -c user.name=x commit`) so that common inline
// form can't slip a commit past the deny. Used both to scope commit-message
// scrubbing and to route raw commits to the git_commit tool.
var gitCommitRe = regexp.MustCompile(`(?i)(?:^|[\n;&|(])\s*git\s+(?:-c\s+\S+\s+|-[^\s]+\s+)*commit\b`)

// gitToolSubcmdRe matches a raw `git <sub>` write-subcommand that has a
// mcp__hydra__git_* equivalent, for the readonly-mode redirect. Same boundary +
// leading-flag skipping as gitCommitRe.
var gitToolSubcmdRe = regexp.MustCompile(`(?i)(?:^|[\n;&|(])\s*git\s+(?:-c\s+\S+\s+|-[^\s]+\s+)*(commit|add|reset|revert|rebase|cherry-pick|merge)\b`)

// gitInvocationRe matches any git invocation at a command boundary, used to
// confine the read-only advice below to failures that actually came from git.
var gitInvocationRe = regexp.MustCompile(`(?i)(?:^|[\n;&|(])\s*git\s`)

// readOnlyFSRe matches the OS error a write to the read-only .git produces.
var readOnlyFSRe = regexp.MustCompile(`(?i)read-only file system`)

// GitReadonlyAdvice returns guidance to attach to a Bash call that already ran
// and failed because .git is read-only (git_isolation=readonly), or "" when the
// output shows no such failure. This replaces the pre-execution deny that used
// to stand here: under readonly the OS is the real boundary, so the command is
// allowed to run and this explains the wreckage afterwards.
//
// Keying off the OUTPUT rather than the command means it also covers the writes
// no redirect table anticipated (`git stash`, `git tag`, `git worktree add`),
// which previously hit the same wall with no explanation at all. When the
// command does map to a git_* tool, the advice names it.
func GitReadonlyAdvice(cmd, output string) string {
	if !gitInvocationRe.MatchString(cmd) || !readOnlyFSRe.MatchString(output) {
		return ""
	}
	const why = "This failed because your .git is read-only in the sandbox (git_isolation=readonly), not because of the command itself - nothing was changed. Read-only git (status/diff/log/show) still works in the shell, and you can edit and delete files normally."
	m := gitToolSubcmdRe.FindStringSubmatch(cmd)
	if m == nil {
		return why + " Git writes have to go through the mcp__hydra__git_* tools, which run on your own branch host-side."
	}
	sub := strings.ToLower(m[1])
	tool := map[string]string{
		"commit":      "git_commit",
		"add":         "git_add",
		"reset":       "git_reset",
		"revert":      "git_revert",
		"rebase":      "git_rebase (or git_rebase_continue / git_rebase_abort)",
		"cherry-pick": "git_cherry_pick",
		"merge":       "git_merge (or git_merge_continue / git_merge_abort)",
	}[sub]
	return fmt.Sprintf("%s Use the mcp__hydra__%s tool instead of `git %s` - it runs the operation on your own branch, host-side.", why, tool, sub)
}

// heredocStartRe matches the start of a heredoc and captures its delimiter word
// (tolerating <<- and a quoted delimiter). RE2 has no backreferences, so the
// closing delimiter is matched line-by-line in stripCommitHeredocs.
var heredocStartRe = regexp.MustCompile(`<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)`)

// commitMessageFlagRe matches a -m/--message flag and its value (quoted or a
// single bare token) so a commit message's TEXT isn't scanned by the tripwires.
var commitMessageFlagRe = regexp.MustCompile(`(?i)(?:-m|--message)(?:=|\s+)('[^']*'|"[^"]*"|\S+)`)

// scrubCommitText removes text that is documentation, not executed shell - a git
// commit's -m/--message value and the heredoc body feeding `git commit ... -F -`.
// The Bash tripwires (settings-tamper, global-install, git push, pkill) then don't
// fire on a word that merely appears IN a commit message (e.g. "disableAllHooks"
// plus a stray ">"). A redirect that actually writes a file stays on the command
// line and is unaffected; a non-commit heredoc (`bash <<EOF`) may be executed, so
// its body is deliberately NOT stripped - no detection is weakened.
func scrubCommitText(cmd string) string {
	return commitMessageFlagRe.ReplaceAllString(stripCommitHeredocs(cmd), " ")
}

// stripCommitHeredocs drops the body of any heredoc whose opening line is a
// `git commit` (i.e. a `-F -` commit message). Other heredocs are left intact.
func stripCommitHeredocs(cmd string) string {
	lines := strings.Split(cmd, "\n")
	kept := lines[:0]
	delim := ""
	for _, ln := range lines {
		if delim != "" {
			if strings.TrimSpace(ln) == delim {
				delim = ""
			}
			continue // inside a git-commit heredoc body: drop the line
		}
		kept = append(kept, ln)
		if gitCommitRe.MatchString(ln) {
			if m := heredocStartRe.FindStringSubmatch(ln); m != nil {
				delim = m[1]
			}
		}
	}
	return strings.Join(kept, "\n")
}

// settingsTamperIntentRe matches the hook-disabling settings keys. On its own a
// mention is not enough to deny (it shows up in commit messages, an echo, a grep);
// it only trips when the command also writes (settingsWriteIndicatorRe), i.e. is
// actually setting the key somewhere.
var settingsTamperIntentRe = regexp.MustCompile(`(?i)(disableAllHooks|allowManagedHooksOnly)`)

// settingsWriteIndicatorRe matches any construct that writes to a file (used to
// gate the tamper-intent keys above so a bare mention doesn't false-positive).
var settingsWriteIndicatorRe = regexp.MustCompile(`(?i)(>>?|\btee\b|\bsed\s+-i|\bperl\s+-i|\bdd\b[^|;&]*of=)`)

// settingsPathRe matches a reference to a security-policy settings file.
var settingsPathRe = regexp.MustCompile(`(?i)(managed-settings\.json|\.claude/settings(\.local)?\.json|claude-code/managed)`)

// settingsRedirectRe matches a redirect/tee whose *target* is a settings file.
// Tying it to the path (rather than any `>`) means a stderr redirect while
// reading - `cat settings.json 2>/dev/null` - does not trip the wire.
var settingsRedirectRe = regexp.MustCompile(`(?i)(>>?\s*|\btee\s+(-a\s+)?)['"]?(~|\$HOME|\$\{HOME\})?/?[^\s'"|;&]*?(managed-settings\.json|\.claude/settings(\.local)?\.json|claude-code/managed)`)

// settingsInPlaceRe matches commands that modify their file argument in place or
// overwrite a file (in-place sed/perl, cp/mv/ln/install, truncate/dd, chmod/
// chown). Combined with settingsPathRe (the path appears somewhere in the line),
// this denies writes whose target isn't adjacent to the operator (e.g.
// `sed -i 's/x/y/' settings.json`). Read-only inspection (cat/grep/jq/less/diff)
// uses none of these tokens, so it is allowed. Like the install tripwire this is
// best-effort: the real defense is that the gate hook lives in read-only MANAGED
// settings, so even a successful disableAllHooks write can't disable it.
var settingsInPlaceRe = regexp.MustCompile(`(?i)(\bsed\s+-i|\bperl\s+-i|\b(cp|mv|ln|install|truncate|chmod|chown)\b|\bdd\b[^|;&]*of=)`)

// Decide returns the gate's verdict for one tool call. It is a pure function of
// the policy and the hook payload so it is exhaustively unit-testable. The
// guiding principle (see docs/security-audit.md): recognized built-in tools are allowed (the OS
// sandbox is the boundary), while MCP calls AND tools the gate doesn't recognize
// fail closed (parked for approval) - an un-vetted MCP/connector tool must not
// slip through under a name the mcp__ check misses, even with permissions skipped.
// Newly-shipped built-ins are registered in knownBuiltinTools to stop them parking.
func Decide(p Policy, toolName string, toolInput map[string]any) Result {
	if !p.GateEnabled {
		return Result{Decision: Allow}
	}

	// MCP tool calls: mcp__<server>__<tool> (plugins: mcp__plugin_<p>_<server>__).
	if server, tool, ok := mcpServerTool(toolName); ok {
		// Hydra's own control server (discover/request MCP servers) is always allowed.
		if server == HydraControlServer {
			return Result{Decision: Allow}
		}
		full := server + "__" + tool
		// Prefer the server-declared readOnlyHint captured at seed time; fall back to
		// the name heuristic when the server declared none.
		rw := ClassifyMCPTool(tool)
		if hint := p.MCPToolRW[full]; hint != "" {
			rw = hint
		}
		// Block lists win over every grant: a blocked server/tool is denied outright,
		// never parked - an "always allow" approval could not override it anyway.
		if containsFold(p.MCPBlocked, server) {
			return Result{
				Decision: Deny,
				Reason:   "MCP server " + quote(server) + " is blocked by policy (mcp_blocked)",
			}
		}
		if containsFold(p.MCPToolsBlocked, full) {
			return Result{
				Decision: Deny,
				Reason:   "MCP tool " + quote(full) + " is blocked by policy (mcp_tools_blocked)",
			}
		}
		// Whole-server grant covers every tool.
		if containsFold(p.MCPAllowed, server) {
			return Result{Decision: Allow}
		}
		// Per-tool grant.
		if containsFold(p.MCPToolsAllowed, full) {
			return Result{Decision: Allow}
		}
		// Optional: auto-allow tools the classifier deems read-only.
		if p.AutoAllowReadMCP && rw == "read" {
			return Result{Decision: Allow}
		}
		// A server that already has some per-tool grants is a partially-allowed
		// (kept) server: park THIS tool for approval. A server with no grants at all
		// would have been stripped pre-launch, so parking the whole server is the
		// meaningful ask if it is somehow reached.
		if serverReferenced(p.MCPToolsAllowed, server) {
			return Result{
				Decision: Ask, Kind: "mcp_tool", Target: full, RW: rw,
				ArgsPreview: previewArgs(toolInput),
				Reason:      "MCP tool " + quote(full) + " is not on the allow-list",
			}
		}
		return Result{
			Decision: Ask, Kind: "mcp", Target: server,
			Reason: "MCP server " + quote(server) + " is not on the allow-list",
		}
	}

	switch toolName {
	case "WebFetch":
		// With network filtering off (unrestricted/off) there is nothing to gate -
		// every host is already reachable - so don't park the head. The allow-list
		// and mode are derived from [sandbox.network], not a separate policy field.
		if !p.WebFetchFilter {
			return Result{Decision: Allow}
		}
		host := urlHost(stringArg(toolInput, "url"))
		if host == "" {
			return Result{Decision: Allow}
		}
		if HostAllowed(p.WebFetchBlockedHosts, host) {
			return Result{
				Decision: Deny,
				Reason:   "WebFetch to " + quote(host) + " is blocked by the network policy",
			}
		}
		if HostAllowed(p.WebFetchAllowHosts, host) {
			return Result{Decision: Allow}
		}
		return Result{
			Decision: Ask, Kind: "webfetch", Target: host,
			URL:    stringArg(toolInput, "url"),
			Reason: "WebFetch to " + quote(host) + " is not on the network allow-list",
		}

	case "Write", "Edit", "MultiEdit", "NotebookEdit":
		fp := fileArg(toolInput)
		if p.isPolicyFile(fp) {
			return Result{
				Decision: Deny,
				Reason:   "writing security-policy file " + quote(fp) + " is not allowed (it would let the agent disable its own gate)",
			}
		}
		return Result{Decision: Allow}

	case "Read":
		fp := fileArg(toolInput)
		if p.isCredentialPath(fp) {
			return Result{
				Decision: Deny,
				Reason:   "reading credential file " + quote(fp) + " is not allowed (it is the first step of token exfiltration)",
			}
		}
		return Result{Decision: Allow}

	case "Bash":
		cmd := stringArg(toolInput, "command")
		// Scan a copy with commit-message / commit-heredoc TEXT removed, so a word
		// that merely appears in a commit message doesn't trip a tripwire below.
		cmd = scrubCommitText(cmd)
		if globalInstallRe.MatchString(cmd) {
			return Result{
				Decision: Deny,
				Reason:   "global/system installs are forbidden by the sandbox rules; install project-local deps in the worktree instead",
			}
		}
		writesSettings := settingsRedirectRe.MatchString(cmd) ||
			(settingsInPlaceRe.MatchString(cmd) && settingsPathRe.MatchString(cmd))
		disablesHooks := settingsTamperIntentRe.MatchString(cmd) && settingsWriteIndicatorRe.MatchString(cmd)
		if writesSettings || disablesHooks {
			return Result{
				Decision: Deny,
				Reason:   "modifying Claude settings/hooks from the shell is not allowed (it would let the agent disable its own gate)",
			}
		}
		if procKillRe.MatchString(cmd) {
			return Result{
				Decision: Deny,
				Reason:   "pkill/killall are not allowed - they match processes by name/command-line and will also match this agent's own process (its whole system prompt rides in the `--append-system-prompt` argv) and co-tenant sessions in the same sandbox, killing your session. Kill a background process by its captured PID (`kill \"$PID\"`) or by port (`fuser -k <port>/tcp`) instead.",
			}
		}
		if gitPushRe.MatchString(cmd) && !strings.Contains(cmd, "--dry-run") {
			// git push leaves the sandbox and writes to a remote. We deny it
			// outright rather than parking it for approval: the user pushes
			// deliberately from the host, and an in-sandbox agent has no business
			// requesting to leave the box. (The old "ask" flow is intentionally
			// disabled - see the removed bash approval kind.)
			return Result{
				Decision: Deny,
				Reason:   "git push is not allowed - it leaves the sandbox and writes to a remote (push deliberately from the host instead)",
			}
		}
		// In readonly mode raw git writes cannot succeed: .git is read-only, so the
		// OS refuses the ref lock / index write and the branch is untouched. The
		// deny that used to live here was therefore never a security control - it
		// only bought a friendlier message than "Read-only file system" - and it
		// charged the whole Bash call for that nicety: a compound command like
		// `printf > a && printf > b && git add …` lost its file writes too, because
		// one clause happened to mention git. So allow it, let the OS refuse it,
		// and attach the tool pointer to the failure afterwards (GitReadonlyAdvice,
		// wired as a PostToolUse hook). Fires before the commit check below so a
		// readonly-mode commit takes this path rather than that hard deny.
		if p.HostMediatedGit && gitToolSubcmdRe.MatchString(cmd) {
			return Result{Decision: Allow}
		}
		if gitCommitRe.MatchString(cmd) {
			// Route commits through the mcp__hydra__git_commit tool, which commits onto
			// the head's OWN branch inside its worktree. The whole shared .git is bound
			// writable in the sandbox (a linked worktree needs it), so a raw `git commit`
			// - especially one run from the wrong directory or after `git checkout main`
			// - can land on the main repo or a sibling head's branch. The tool refuses
			// unless HEAD is the head's own branch. Read-only git and `git add` are
			// untouched; this fires after the tamper/push checks so a message mentioning
			// a tripwire (already scrubbed above) or a chained tamper write is still
			// caught with its own reason first.
			return Result{
				Decision: Deny,
				Reason:   "raw `git commit` is not allowed - commit with the mcp__hydra__git_commit tool instead. It stages and commits your changes onto your own branch inside your worktree, so a commit can't land on the main repo or another branch. Read-only git (status/diff/log) and `git add` still work.",
			}
		}
		return Result{Decision: Allow}
	}

	// A recognized built-in tool we don't specially handle above is safe to allow:
	// the OS sandbox confines its blast radius. p.KnownTools lets a project extend
	// the built-in set via config (policy.known_tools) without a code change.
	if knownBuiltinTools[toolName] || containsFold(p.KnownTools, toolName) {
		return Result{Decision: Allow}
	}

	// Unrecognized tool: fail CLOSED. An un-prefixed tool the mcp__ check above
	// didn't catch could be an un-vetted MCP/connector tool exposed under a
	// non-standard name, so parking it (rather than failing open) keeps a head from
	// reaching capabilities the user never allow-listed - even under
	// --dangerously-skip-permissions. Genuinely new built-in tools also land here;
	// the reason tells the head to have the user register it (see defaultKnownToolNames).
	return Result{
		Decision: Ask, Kind: "tool", Target: toolName,
		Reason: "tool " + quote(toolName) + " is not recognized by Hydra's security gate - it may be an un-vetted MCP/connector tool. It has been parked for approval. If this is a legitimate built-in tool, ask the user to add it to policy.known_tools in .hydra/config.toml (or, for a new built-in that should ship recognized, defaultKnownToolNames in internal/gate/decide.go) so Hydra stops gating it.",
	}
}

// defaultKnownToolNames is the built-in allow-list of Claude Code tool names the
// gate recognizes as safe (they run confined by the OS sandbox). Anything NOT here
// (nor in policy.known_tools) and without the mcp__ prefix is parked for approval
// (fail-closed) rather than allowed, so a mystery-named MCP/connector tool can't
// slip through. It is the UNION across agent configs and Claude Code versions -
// keep it broad. When a new built-in tool ships and starts getting parked, add its
// name here (so it ships recognized) or to policy.known_tools (per-project).
//
// Tools the switch above already handles (Bash, Read, Write, Edit, MultiEdit,
// NotebookEdit, WebFetch) are listed too for documentation; they never reach the
// map because their cases return first.
var defaultKnownToolNames = []string{
	// File + shell (also special-cased above).
	"Bash", "BashOutput", "KillBash", "KillShell",
	"Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead",
	"Glob", "Grep", "LS",
	// Web.
	"WebFetch", "WebSearch",
	// Planning / control.
	"ExitPlanMode", "EnterPlanMode", "TodoWrite", "SlashCommand", "Skill",
	// Sub-agents + orchestration.
	"Task", "Agent", "Workflow", "ToolSearch", "Monitor",
	// Task list.
	"TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
	// Scheduling / notifications / messaging.
	"CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
	"PushNotification", "RemoteTrigger", "SendMessage",
	// Worktrees, design, artifacts, reporting, LSP.
	"EnterWorktree", "ExitWorktree", "DesignSync", "Artifact",
	"AskUserQuestion", "ReportFindings", "LSP",
}

var knownBuiltinTools = func() map[string]bool {
	m := make(map[string]bool, len(defaultKnownToolNames))
	for _, n := range defaultKnownToolNames {
		m[n] = true
	}
	return m
}()

// DefaultKnownTools returns the built-in known-tool allow-list, sorted, so the
// config generator can document it as the default for policy.known_tools. The
// returned slice is a fresh copy the caller may keep but must not rely on for
// order beyond "sorted".
func DefaultKnownTools() []string {
	out := append([]string(nil), defaultKnownToolNames...)
	sort.Strings(out)
	return out
}

// mcpServerTool splits an MCP tool call name into its server and tool segments,
// or reports false for a non-MCP tool. mcp__<server>__<tool> → (<server>, <tool>).
// A malformed name with no tool segment treats the remainder as the server and
// leaves the tool empty.
func mcpServerTool(name string) (server, tool string, ok bool) {
	if !strings.HasPrefix(name, "mcp__") {
		return "", "", false
	}
	rest := strings.TrimPrefix(name, "mcp__")
	server, tool, _ = strings.Cut(rest, "__")
	return server, tool, true
}

// readVerbs / writeVerbs classify an MCP tool by the leading verb in its name.
// This is a best-effort heuristic used for the approval-card read/write badge and
// the optional auto-allow-read policy - NOT a security guarantee (a server can
// name a destructive tool "get_*"). A future enhancement can replace/augment this
// with the server-declared readOnlyHint annotation captured from tools/list.
var (
	readVerbs  = []string{"get", "list", "read", "search", "find", "fetch", "query", "describe", "show", "view", "lookup", "count", "check", "browse", "inspect"}
	writeVerbs = []string{"create", "update", "delete", "write", "post", "put", "patch", "set", "add", "remove", "edit", "insert", "send", "run", "exec", "execute", "modify", "move", "rename", "upload", "publish", "merge", "close", "cancel", "trigger", "deploy"}
)

// ClassifyMCPTool returns "read", "write", or "" (unknown) for an MCP tool name,
// by matching a leading verb (split on '_', '-', or camelCase). Best-effort only.
func ClassifyMCPTool(tool string) string {
	verb := leadingVerb(tool)
	if verb == "" {
		return ""
	}
	if slices.Contains(readVerbs, verb) {
		return "read"
	}
	if slices.Contains(writeVerbs, verb) {
		return "write"
	}
	return ""
}

// leadingVerb extracts the first word of a tool name, lower-cased. It splits on
// the first '_' or '-', or (for camelCase like "createIssue") at the first
// upper-case letter after the initial run of lower-case letters.
func leadingVerb(tool string) string {
	if tool == "" {
		return ""
	}
	if i := strings.IndexAny(tool, "_-"); i >= 0 {
		return strings.ToLower(tool[:i])
	}
	for i, r := range tool {
		if i > 0 && r >= 'A' && r <= 'Z' {
			return strings.ToLower(tool[:i])
		}
	}
	return strings.ToLower(tool)
}

// isPolicyFile reports whether path is a security-relevant policy file the agent
// must not rewrite: any settings.json under a .claude dir, the seeded
// ~/.claude/settings.json or ~/.claude.json, an .mcp.json, or a hook script
// under .github/hooks/.
func (p Policy) isPolicyFile(path string) bool {
	if path == "" {
		return false
	}
	abs := p.resolve(path)
	base := filepath.Base(abs)
	switch base {
	case ".mcp.json", ".claude.json", "managed-settings.json":
		return true
	case "settings.json", "settings.local.json":
		// Only under a .claude directory (e.g. ~/.claude/settings.json or a repo's
		// .claude/settings.json), not any unrelated settings.json.
		return strings.Contains(filepath.ToSlash(abs), "/.claude/")
	}
	return strings.Contains(filepath.ToSlash(abs), "/.github/hooks/")
}

// isCredentialPath reports whether path resolves into a reachable provider /
// GitHub credential the agent has no legitimate reason to read.
func (p Policy) isCredentialPath(path string) bool {
	if path == "" || p.Home == "" {
		return false
	}
	abs := p.resolve(path)
	home := filepath.Clean(p.Home)
	for _, rel := range credentialRels {
		target := filepath.Join(home, rel)
		if abs == target || strings.HasPrefix(abs, target+string(filepath.Separator)) {
			return true
		}
	}
	// Project-relative secret files Hydra creates (mirrors the sandbox mask
	// defaults, sandbox.ProjectRelativeMaskDefaults). Checked here as
	// defense-in-depth for the Read tool even though they are also masked on disk.
	if p.ProjectRoot != "" {
		root := filepath.Clean(p.ProjectRoot)
		for _, rel := range projectCredentialRels {
			target := filepath.Join(root, rel)
			if abs == target || strings.HasPrefix(abs, target+string(filepath.Separator)) {
				return true
			}
		}
	}
	return false
}

// credentialRels are HOME-relative paths holding reusable provider/GitHub
// secrets. ~/.claude is intentionally excluded (it holds the agent's own
// conversation state it must read); the token-bearing ~/.claude.json and
// ~/.claude/.credentials.json are listed explicitly instead.
var credentialRels = []string{
	".claude.json",
	".claude/.credentials.json",
	".config/gh",
	".gemini/oauth_creds.json",
	".gemini/google_accounts.json",
	".codex/auth.json",
	".copilot/apps.json",
}

// projectCredentialRels are PROJECT-root-relative secret/per-machine-state files
// Hydra itself creates and no head should read. They mirror
// sandbox.ProjectRelativeMaskDefaults (kept in sync by hand - both lists are tiny
// and the gate package must not import sandbox).
var projectCredentialRels = []string{
	".hydra/deploy.toml",
	".hydra/config.local.toml",
}

// resolve makes path absolute, expanding a leading ~ against the policy's Home.
func (p Policy) resolve(path string) string {
	if path == "~" {
		return filepath.Clean(p.Home)
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(p.Home, path[2:])
	}
	if !filepath.IsAbs(path) && p.WorktreePath != "" {
		// A relative tool path is relative to the agent's cwd (its worktree).
		return filepath.Join(p.WorktreePath, path)
	}
	return filepath.Clean(path)
}

// fileArg pulls the file path from a tool input, tolerating the few keys the
// file tools use (file_path for Edit/Write, notebook_path for NotebookEdit).
func fileArg(input map[string]any) string {
	for _, k := range []string{"file_path", "notebook_path", "path"} {
		if v := stringArg(input, k); v != "" {
			return v
		}
	}
	return ""
}

// previewArgs renders a tool call's arguments as compact JSON for the approval
// card, which parses it back and pretty-prints it with syntax highlighting. The
// cap keeps a pathological payload from blowing up the toast; a truncated value
// is no longer valid JSON, so the card falls back to showing it as raw text.
func previewArgs(input map[string]any) string {
	if len(input) == 0 {
		return ""
	}
	data, err := json.Marshal(input)
	if err != nil {
		return ""
	}
	s := string(data)
	const max = 2000
	if len(s) > max {
		s = s[:max-1] + "..."
	}
	return s
}

func stringArg(input map[string]any, key string) string {
	if v, ok := input[key].(string); ok {
		return v
	}
	return ""
}

// urlHost returns the lowercase host of a URL, or "" if it can't be parsed.
func urlHost(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// HostAllowed reports whether host matches an allow-list entry: an exact
// (case-insensitive) match, or a "*.suffix" / ".suffix" wildcard covering the
// host and its subdomains. Shared with the egress proxy so the gate and the
// network filter apply the same matching rules.
func HostAllowed(allow []string, host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, a := range allow {
		a = strings.ToLower(strings.TrimSpace(a))
		if a == "" {
			continue
		}
		if suffix, ok := strings.CutPrefix(a, "*."); ok {
			if host == suffix || strings.HasSuffix(host, "."+suffix) {
				return true
			}
			continue
		}
		if suffix, ok := strings.CutPrefix(a, "."); ok {
			if host == suffix || strings.HasSuffix(host, "."+suffix) {
				return true
			}
			continue
		}
		if host == a {
			return true
		}
	}
	return false
}

// serverReferenced reports whether any "<server>__<tool>" entry names server.
func serverReferenced(toolsAllowed []string, server string) bool {
	for _, t := range toolsAllowed {
		s, _, _ := strings.Cut(t, "__")
		if strings.EqualFold(strings.TrimSpace(s), server) {
			return true
		}
	}
	return false
}

func containsFold(list []string, want string) bool {
	for _, v := range list {
		if strings.EqualFold(strings.TrimSpace(v), want) {
			return true
		}
	}
	return false
}

func quote(s string) string { return "\"" + s + "\"" }
