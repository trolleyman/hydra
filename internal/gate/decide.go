package gate

import (
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

// Decision is the gate's verdict for a single tool call.
type Decision string

const (
	// Allow lets the tool proceed (the hook emits nothing — silence = proceed).
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
	// "mcp" (Target is the server name) or "webfetch" (Target is the host).
	Kind string
	// Target is the server/host an Ask is about (for the approval UI + remember).
	Target string
}

// globalInstallRe matches Bash commands that install system- or user-global
// software, which the pre-prompt forbids. It is a deliberate tripwire, not an
// airtight boundary (a determined agent can re-encode a command) — the real
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

// gitPushRe matches a `git push` (the remote-affecting action that leaves the
// box), excluding `--dry-run`.
var gitPushRe = regexp.MustCompile(`(?i)\bgit\s+(-[^\s]+\s+)*push\b`)

// Decide returns the gate's verdict for one tool call. It is a pure function of
// the policy and the hook payload so it is exhaustively unit-testable. The
// guiding principle (see AUDIT.md): default-allow for unrecognized tools (the OS
// sandbox is the boundary; a fail-closed gate would block every new tool), and
// fail-closed only for MCP, where the allow-list is the point.
func Decide(p Policy, toolName string, toolInput map[string]any) Result {
	if !p.GateEnabled {
		return Result{Decision: Allow}
	}

	// MCP tool calls: mcp__<server>__<tool> (plugins: mcp__plugin_<p>_<server>__).
	if server, ok := mcpServer(toolName); ok {
		if containsFold(p.MCPAllowed, server) {
			return Result{Decision: Allow}
		}
		return Result{
			Decision: Ask, Kind: "mcp", Target: server,
			Reason: "MCP server " + quote(server) + " is not on the allow-list",
		}
	}

	switch toolName {
	case "WebFetch":
		host := urlHost(stringArg(toolInput, "url"))
		if host == "" {
			return Result{Decision: Allow}
		}
		if HostAllowed(p.WebFetchAllowHosts, host) {
			return Result{Decision: Allow}
		}
		return Result{
			Decision: Ask, Kind: "webfetch", Target: host,
			Reason: "WebFetch to " + quote(host) + " is not on the allow-list",
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
		if globalInstallRe.MatchString(cmd) {
			return Result{
				Decision: Deny,
				Reason:   "global/system installs are forbidden by the sandbox rules; install project-local deps in the worktree instead",
			}
		}
		if gitPushRe.MatchString(cmd) && !strings.Contains(cmd, "--dry-run") {
			return Result{
				Decision: Ask, Kind: "bash", Target: "git push",
				Reason: "git push leaves the sandbox and writes to a remote",
			}
		}
		return Result{Decision: Allow}
	}

	// Unrecognized tool: fail open. The OS sandbox confines the blast radius.
	return Result{Decision: Allow}
}

// mcpServer extracts the server name from an MCP tool call name, or reports
// false for a non-MCP tool. mcp__<server>__<tool> → <server>.
func mcpServer(tool string) (string, bool) {
	if !strings.HasPrefix(tool, "mcp__") {
		return "", false
	}
	rest := strings.TrimPrefix(tool, "mcp__")
	// The server is everything up to the next "__" (which separates the tool). A
	// malformed name with no tool segment treats the remainder as the server.
	server, _, _ := strings.Cut(rest, "__")
	return server, true
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
	case ".mcp.json", ".claude.json":
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

func containsFold(list []string, want string) bool {
	for _, v := range list {
		if strings.EqualFold(strings.TrimSpace(v), want) {
			return true
		}
	}
	return false
}

func quote(s string) string { return "\"" + s + "\"" }
