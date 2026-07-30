package gate

import (
	"slices"
	"strings"
	"testing"
)

func basePolicy() Policy {
	return Policy{
		GateEnabled:        true,
		MCPAllowed:         []string{"github"},
		WebFetchFilter:     true,
		WebFetchAllowHosts: []string{"docs.anthropic.com", "*.example.com"},
		Home:               "/home/agent",
		WorktreePath:       "/home/agent/work",
	}
}

func TestDecide(t *testing.T) {
	p := basePolicy()
	cases := []struct {
		name  string
		tool  string
		input map[string]any
		want  Decision
	}{
		{"allowlisted mcp", "mcp__github__create_issue", nil, Allow},
		{"unknown mcp asks", "mcp__evil__run", nil, Ask},
		{"plugin mcp unknown asks", "mcp__plugin_x_evil__run", nil, Ask},
		{"webfetch allowed exact", "WebFetch", map[string]any{"url": "https://docs.anthropic.com/x"}, Allow},
		{"webfetch allowed wildcard", "WebFetch", map[string]any{"url": "https://api.example.com/x"}, Allow},
		{"webfetch new host asks", "WebFetch", map[string]any{"url": "https://evil.test/steal"}, Ask},
		{"write policy settings denied", "Write", map[string]any{"file_path": "/home/agent/.claude/settings.json"}, Deny},
		{"write repo claude settings denied", "Edit", map[string]any{"file_path": "/home/agent/work/.claude/settings.json"}, Deny},
		{"write mcp.json denied", "Write", map[string]any{"file_path": "/home/agent/work/.mcp.json"}, Deny},
		{"write github hook denied", "Write", map[string]any{"file_path": "/home/agent/work/.github/hooks/x.json"}, Deny},
		{"write normal file allowed", "Write", map[string]any{"file_path": "/home/agent/work/main.go"}, Allow},
		{"write tilde policy denied", "Write", map[string]any{"file_path": "~/.claude.json"}, Deny},
		{"read claude.json denied", "Read", map[string]any{"file_path": "/home/agent/.claude.json"}, Deny},
		{"read gh config denied", "Read", map[string]any{"file_path": "/home/agent/.config/gh/hosts.yml"}, Deny},
		{"read credentials denied", "Read", map[string]any{"file_path": "~/.claude/.credentials.json"}, Deny},
		{"read own convo allowed", "Read", map[string]any{"file_path": "/home/agent/.claude/projects/x.jsonl"}, Allow},
		{"read normal file allowed", "Read", map[string]any{"file_path": "/home/agent/work/main.go"}, Allow},
		{"bash apt install denied", "Bash", map[string]any{"command": "sudo apt-get install ripgrep"}, Deny},
		{"bash npm global denied", "Bash", map[string]any{"command": "npm install -g typescript"}, Deny},
		{"bash cargo install denied", "Bash", map[string]any{"command": "cargo install ripgrep"}, Deny},
		{"bash local install allowed", "Bash", map[string]any{"command": "bun install"}, Allow},
		{"bash disableAllHooks denied", "Bash", map[string]any{"command": `echo '{"disableAllHooks":true}' > .claude/settings.json`}, Deny},
		{"bash settings write denied", "Bash", map[string]any{"command": "tee ~/.claude/settings.json"}, Deny},
		{"bash redirect into settings denied", "Bash", map[string]any{"command": "echo {} > ~/.claude/settings.json"}, Deny},
		{"bash sed -i settings denied", "Bash", map[string]any{"command": "sed -i 's/x/y/' /etc/claude-code/managed-settings.json"}, Deny},
		{"bash cp over settings denied", "Bash", map[string]any{"command": "cp /tmp/evil ~/.claude/settings.json"}, Deny},
		// Read-only inspection of the same files must NOT trip the wire.
		{"bash cat settings allowed", "Bash", map[string]any{"command": "cat /etc/claude-code/managed-settings.json"}, Allow},
		{"bash cat settings stderr-redirect allowed", "Bash", map[string]any{"command": "cat ~/.claude/settings.json 2>/dev/null"}, Allow},
		{"bash grep settings allowed", "Bash", map[string]any{"command": "grep model ~/.claude/settings.json"}, Allow},
		{"bash jq settings allowed", "Bash", map[string]any{"command": "jq .hooks /etc/claude-code/managed-settings.json | head"}, Allow},
		// A bare mention of the tamper keys (no write) is allowed - e.g. echoing the
		// key name. (A commit message mentioning it is now denied as a commit, below.)
		{"bash echo key no write allowed", "Bash", map[string]any{"command": "echo checking for disableAllHooks"}, Allow},
		{"bash write tamper key denied", "Bash", map[string]any{"command": `printf disableAllHooks >> /tmp/x`}, Deny},
		{"write managed settings denied", "Write", map[string]any{"file_path": "/etc/claude-code/managed-settings.json"}, Deny},
		{"bash git push denied", "Bash", map[string]any{"command": "git push origin main"}, Deny},
		{"bash git push dry-run allowed", "Bash", map[string]any{"command": "git push --dry-run"}, Allow},
		{"bash chained git push denied", "Bash", map[string]any{"command": "echo done && git push origin main"}, Deny},
		// The bare substring "git push" inside an argument / grep pattern must NOT
		// trip the wire - matching those would hard-deny a legitimate command (the
		// anchor to a command boundary is what saves them).
		{"bash grep for git push allowed", "Bash", map[string]any{"command": "grep -rn 'git push' internal/"}, Allow},
		// Raw `git commit` is denied - it is routed through the mcp__hydra__git_commit
		// tool so a commit can't land on the main repo or a sibling head's branch.
		{"bash git commit denied", "Bash", map[string]any{"command": "git commit -m 'wip'"}, Deny},
		{"bash git commit -am denied", "Bash", map[string]any{"command": "git commit -am 'wip'"}, Deny},
		{"bash git commit amend denied", "Bash", map[string]any{"command": "git commit --amend --no-edit"}, Deny},
		{"bash git -c commit denied", "Bash", map[string]any{"command": "git -c user.name=x commit -m y"}, Deny},
		{"bash chained git commit denied", "Bash", map[string]any{"command": "go build ./... && git commit -m done"}, Deny},
		// ...but read-only git and staging stay allowed (they don't create history or
		// move refs), and the bare substring "git commit" in an argument doesn't trip.
		{"bash git status allowed", "Bash", map[string]any{"command": "git status"}, Allow},
		{"bash git diff allowed", "Bash", map[string]any{"command": "git diff --stat HEAD"}, Allow},
		{"bash git log allowed", "Bash", map[string]any{"command": "git log --oneline -5"}, Allow},
		{"bash git add allowed", "Bash", map[string]any{"command": "git add -A"}, Allow},
		{"bash grep for git commit allowed", "Bash", map[string]any{"command": "grep -rn 'git commit' internal/"}, Allow},
		{"bash pkill denied", "Bash", map[string]any{"command": "pkill -f simulation"}, Deny},
		{"bash killall denied", "Bash", map[string]any{"command": "killall node"}, Deny},
		{"bash chained pkill denied", "Bash", map[string]any{"command": "rm -f x && pkill -f 'go run'"}, Deny},
		{"bash sudo pkill denied", "Bash", map[string]any{"command": "sudo pkill claude"}, Deny},
		// A bare mention of pkill in an argument / echo / grep must NOT trip the wire
		// (the command-boundary anchor is what saves them), and kill-by-PID is fine.
		{"bash echo mentioning pkill allowed", "Bash", map[string]any{"command": "echo 'do not use pkill here'"}, Allow},
		{"bash grep for pkill allowed", "Bash", map[string]any{"command": "grep -rn pkill internal/"}, Allow},
		{"bash kill by pid allowed", "Bash", map[string]any{"command": "kill \"$SRV\""}, Allow},
		// A grep ALTERNATION is not a pipe: `\|` inside a quoted pattern used to read
		// as a command boundary, so searching for these very words was denied.
		{"bash grep alternation naming pkill allowed", "Bash", map[string]any{"command": `grep -rn "pkill\|killall\|pgrep" internal/gate/`}, Allow},
		{"bash grep alternation naming git push allowed", "Bash", map[string]any{"command": `grep -rn "git push\|git commit" docs/`}, Allow},
		// pkill spelled out: pgrep/pidof resolves by name or (with -f) whole command
		// line, and every head's argv carries the entire system prompt.
		{"bash kill pgrep subshell denied", "Bash", map[string]any{"command": `kill $(pgrep -f "server --simulation" | head -1)`}, Deny},
		{"bash pgrep piped to xargs kill denied", "Bash", map[string]any{"command": "pgrep -f 'go run' | xargs kill -9"}, Deny},
		{"bash kill pidof denied", "Bash", map[string]any{"command": "kill $(pidof node)"}, Deny},
		{"bash chained kill pgrep denied", "Bash", map[string]any{"command": "cd /tmp && kill $(pgrep -f vite) ; echo done"}, Deny},
		// Either half alone is legitimate: listing pids, or killing one you captured.
		{"bash bare pgrep allowed", "Bash", map[string]any{"command": "pgrep -f 'go run' | head -5"}, Allow},
		{"bash kill by port allowed", "Bash", map[string]any{"command": "fuser -k 26601/tcp"}, Allow},
		{"bash normal allowed", "Bash", map[string]any{"command": "go test ./..."}, Allow},
		// `git commit` is now denied outright (routed to the tool), but scrubbing of
		// commit-message TEXT still runs first so the deny carries the commit-routing
		// reason rather than a tripwire misfire - and a NON-commit heredoc into a
		// settings file is still caught as a real write (no bypass).
		{"bash commit -m mentioning apt install denied", "Bash", map[string]any{"command": `git commit -m "document the apt-get install flow"`}, Deny},
		{"bash commit heredoc denied", "Bash", map[string]any{"command": "git commit -F - <<'EOF'\nnote: disableAllHooks and a > char in the body\nEOF"}, Deny},
		{"bash non-commit heredoc into settings denied", "Bash", map[string]any{"command": "cat > ~/.claude/settings.json <<'EOF'\n{\"disableAllHooks\":true}\nEOF"}, Deny},
		{"bash tamper write chained after commit denied", "Bash", map[string]any{"command": `git commit -m ok && printf disableAllHooks >> ~/.claude/settings.json`}, Deny},
		{"unrecognized tool parked", "SomeNewTool", map[string]any{"x": "y"}, Ask},
		{"websearch allowed", "WebSearch", map[string]any{"query": "x"}, Allow},
		{"known builtin grep allowed", "Grep", map[string]any{"pattern": "x"}, Allow},
		{"known builtin task allowed", "Task", map[string]any{"prompt": "x"}, Allow},
		{"known builtin todowrite allowed", "TodoWrite", map[string]any{"todos": nil}, Allow},
		{"codex apply patch allowed", "apply_patch", map[string]any{"command": "*** Begin Patch"}, Allow},
		{"codex update plan allowed", "update_plan", map[string]any{"plan": nil}, Allow},
		{"codex collaboration allowed", "spawn_agent", map[string]any{"prompt": "x"}, Allow},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Decide(p, c.tool, c.input)
			if got.Decision != c.want {
				t.Errorf("Decide(%s) = %s (%s), want %s", c.tool, got.Decision, got.Reason, c.want)
			}
		})
	}
}

// TestDecideMCPBlockLists verifies mcp_blocked / mcp_tools_blocked deny outright
// (never park) and that block overrides allow.
func TestDecideMCPBlockLists(t *testing.T) {
	p := basePolicy()
	p.MCPAllowed = []string{"github", "evil"} // evil allowed AND blocked: block wins
	p.MCPBlocked = []string{"evil"}
	p.MCPToolsBlocked = []string{"github__delete_repo"}

	cases := []struct {
		name string
		tool string
		want Decision
	}{
		{"blocked server denied despite allow", "mcp__evil__run", Deny},
		{"blocked tool denied despite server allow", "mcp__github__delete_repo", Deny},
		{"sibling tool of blocked tool still allowed", "mcp__github__create_issue", Allow},
		{"unrelated unknown server still parks", "mcp__other__run", Ask},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Decide(p, c.tool, nil)
			if got.Decision != c.want {
				t.Errorf("Decide(%s) = %s (%s), want %s", c.tool, got.Decision, got.Reason, c.want)
			}
		})
	}
}

func TestDecideGateDisabledAllowsEverything(t *testing.T) {
	p := basePolicy()
	p.GateEnabled = false
	for _, tc := range []struct {
		tool  string
		input map[string]any
	}{
		{"mcp__evil__run", nil},
		{"Read", map[string]any{"file_path": "/home/agent/.claude.json"}},
		{"Bash", map[string]any{"command": "sudo apt install x"}},
	} {
		if got := Decide(p, tc.tool, tc.input); got.Decision != Allow {
			t.Errorf("gate disabled: Decide(%s) = %s, want allow", tc.tool, got.Decision)
		}
	}
}

func TestDecideWebFetchFromNetworkPolicy(t *testing.T) {
	// Filtering off (unrestricted/off network mode): WebFetch is never gated, even a
	// brand-new host - there is nothing to gate because every host is reachable.
	p := basePolicy()
	p.WebFetchFilter = false
	if r := Decide(p, "WebFetch", map[string]any{"url": "https://brand-new.test/x"}); r.Decision != Allow {
		t.Errorf("filtering off should allow any WebFetch host, got %s", r.Decision)
	}

	// A blocked host is denied outright (not parked): "always allow" could not
	// override a block anyway.
	p = basePolicy()
	p.WebFetchBlockedHosts = []string{"blocked.example.com"}
	// (blocked.example.com would otherwise match the *.example.com allow entry.)
	if r := Decide(p, "WebFetch", map[string]any{"url": "https://blocked.example.com/x"}); r.Decision != Deny {
		t.Errorf("blocked host should be denied, got %s", r.Decision)
	}
	// A non-blocked host on the allow-list still passes.
	if r := Decide(p, "WebFetch", map[string]any{"url": "https://api.example.com/x"}); r.Decision != Allow {
		t.Errorf("allow-listed host should pass, got %s", r.Decision)
	}
}

func TestDecideAskCarriesTarget(t *testing.T) {
	p := basePolicy()
	if r := Decide(p, "mcp__evil__run", nil); r.Kind != "mcp" || r.Target != "evil" {
		t.Errorf("mcp ask target: kind=%q target=%q", r.Kind, r.Target)
	}
	if r := Decide(p, "WebFetch", map[string]any{"url": "https://evil.test/x"}); r.Kind != "webfetch" || r.Target != "evil.test" {
		t.Errorf("webfetch ask target: kind=%q target=%q", r.Kind, r.Target)
	}
}

// A denied `git commit` points the agent at the git_commit tool - and commit-msg
// scrubbing runs first, so a message that merely mentions a tripwire (an install,
// a tamper key) is still denied with the commit-routing reason, not a misfire.
func TestDecideGitCommitRoutesToTool(t *testing.T) {
	p := basePolicy()
	for _, cmd := range []string{
		"git commit -m 'wip'",
		`git commit -m "run apt-get install foo and pkill bar"`,
	} {
		r := Decide(p, "Bash", map[string]any{"command": cmd})
		if r.Decision != Deny || !strings.Contains(r.Reason, "git_commit") {
			t.Errorf("Decide(Bash %q) = %s (%q), want Deny mentioning git_commit", cmd, r.Decision, r.Reason)
		}
	}
}

// An un-vetted tool exposed under a name the mcp__ check doesn't catch (e.g. a
// claude.ai connector surfaced without the prefix) must fail closed - parked as
// kind "tool" carrying the tool name - so it can't run even under skip-permissions.
func TestDecideUnrecognizedToolFailsClosed(t *testing.T) {
	p := basePolicy()
	r := Decide(p, "google_calendar_create_event", nil)
	if r.Decision != Ask {
		t.Fatalf("unrecognized tool decision = %s, want Ask", r.Decision)
	}
	if r.Kind != "tool" || r.Target != "google_calendar_create_event" {
		t.Errorf("unrecognized tool ask: kind=%q target=%q", r.Kind, r.Target)
	}
	// A recognized built-in that the switch doesn't special-case still fails open.
	if r := Decide(p, "Glob", map[string]any{"pattern": "**/*.go"}); r.Decision != Allow {
		t.Errorf("known builtin Glob = %s, want Allow", r.Decision)
	}
}

// policy.known_tools extends the built-in allow-list so a project can register a
// tool the gate doesn't ship recognizing, instead of parking every call.
func TestDecideKnownToolsExtends(t *testing.T) {
	p := basePolicy()
	if r := Decide(p, "AcmeCustomTool", nil); r.Decision != Ask {
		t.Fatalf("unregistered custom tool = %s, want Ask", r.Decision)
	}
	p.KnownTools = []string{"AcmeCustomTool"}
	if r := Decide(p, "AcmeCustomTool", nil); r.Decision != Allow {
		t.Errorf("registered custom tool = %s, want Allow", r.Decision)
	}
	// Case-insensitive, matching the MCP allow-list semantics.
	if r := Decide(p, "acmecustomtool", nil); r.Decision != Allow {
		t.Errorf("registered custom tool (case-insensitive) = %s, want Allow", r.Decision)
	}
}

// DefaultKnownTools is sorted, non-empty, and a copy (mutating it must not affect
// the gate). It backs the documented default for policy.known_tools.
func TestDefaultKnownTools(t *testing.T) {
	a := DefaultKnownTools()
	if len(a) == 0 {
		t.Fatal("DefaultKnownTools is empty")
	}
	if !slices.IsSorted(a) {
		t.Errorf("DefaultKnownTools is not sorted: %v", a)
	}
	a[0] = "ZZZ-mutated"
	if Decide(basePolicy(), "Bash", map[string]any{"command": "echo hi"}).Decision != Allow {
		t.Error("mutating DefaultKnownTools result affected the gate")
	}
}

func TestDecidePerToolMCP(t *testing.T) {
	p := basePolicy()
	// linear is NOT a whole-server grant, but two of its tools are.
	p.MCPToolsAllowed = []string{"linear__list_issues", "linear__create_issue"}

	cases := []struct {
		name string
		tool string
		want Decision
		kind string
	}{
		{"whole-server grant covers all tools", "mcp__github__delete_repo", Allow, ""},
		{"per-tool grant allows that tool", "mcp__linear__create_issue", Allow, ""},
		{"other tool of partially-allowed server parks per-tool", "mcp__linear__delete_issue", Ask, "mcp_tool"},
		{"unknown server parks whole-server", "mcp__evil__run", Ask, "mcp"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Decide(p, c.tool, nil)
			if got.Decision != c.want {
				t.Errorf("Decide(%s) = %s, want %s", c.tool, got.Decision, c.want)
			}
			if c.kind != "" && got.Kind != c.kind {
				t.Errorf("Decide(%s) kind = %q, want %q", c.tool, got.Kind, c.kind)
			}
		})
	}

	// The per-tool ask carries the "<server>__<tool>" target and rw badge.
	if r := Decide(p, "mcp__linear__delete_issue", nil); r.Target != "linear__delete_issue" || r.RW != "write" {
		t.Errorf("per-tool ask: target=%q rw=%q, want linear__delete_issue/write", r.Target, r.RW)
	}
}

func TestDecideCapturedHintOverridesHeuristic(t *testing.T) {
	p := basePolicy()
	p.MCPToolsAllowed = []string{"linear__create_issue"} // keep linear partially-allowed
	// The name heuristic would call delete_* a write; the captured readOnlyHint says
	// read. The captured hint must win.
	p.MCPToolRW = map[string]string{"linear__delete_issue": "read"}
	if r := Decide(p, "mcp__linear__delete_issue", nil); r.RW != "read" {
		t.Errorf("captured hint should override heuristic: rw=%q, want read", r.RW)
	}
	// A tool with no captured hint still uses the heuristic.
	if r := Decide(p, "mcp__linear__update_issue", nil); r.RW != "write" {
		t.Errorf("no hint should fall back to heuristic: rw=%q, want write", r.RW)
	}
}

func TestDecideAutoAllowRead(t *testing.T) {
	p := basePolicy()
	p.MCPToolsAllowed = []string{"linear__create_issue"} // keeps linear partially-allowed
	p.AutoAllowReadMCP = true
	if r := Decide(p, "mcp__linear__list_issues", nil); r.Decision != Allow {
		t.Errorf("auto-allow-read should allow a read tool, got %s", r.Decision)
	}
	if r := Decide(p, "mcp__linear__delete_issue", nil); r.Decision != Ask {
		t.Errorf("auto-allow-read must still park a write tool, got %s", r.Decision)
	}
}

func TestClassifyMCPTool(t *testing.T) {
	reads := []string{"get_issue", "list_issues", "searchCode", "fetch", "query_db", "read-file"}
	writes := []string{"create_issue", "delete_repo", "updateRecord", "post_message", "run_query", "sendEmail"}
	unknown := []string{"", "frobnicate", "xyzzy_thing"}
	for _, s := range reads {
		if got := ClassifyMCPTool(s); got != "read" {
			t.Errorf("ClassifyMCPTool(%q) = %q, want read", s, got)
		}
	}
	for _, s := range writes {
		if got := ClassifyMCPTool(s); got != "write" {
			t.Errorf("ClassifyMCPTool(%q) = %q, want write", s, got)
		}
	}
	for _, s := range unknown {
		if got := ClassifyMCPTool(s); got != "" {
			t.Errorf("ClassifyMCPTool(%q) = %q, want unknown", s, got)
		}
	}
}

func TestHostAllowed(t *testing.T) {
	allow := []string{"exact.com", "*.wild.com", ".dot.com"}
	yes := []string{"exact.com", "a.wild.com", "b.a.wild.com", "wild.com", "dot.com", "x.dot.com"}
	no := []string{"notexact.com", "exact.com.evil.com", "wildxcom", "evil.com"}
	for _, h := range yes {
		if !HostAllowed(allow, h) {
			t.Errorf("hostAllowed(%q) = false, want true", h)
		}
	}
	for _, h := range no {
		if HostAllowed(allow, h) {
			t.Errorf("hostAllowed(%q) = true, want false", h)
		}
	}
}

func TestReadonlyGitRedirect(t *testing.T) {
	ro := basePolicy()
	ro.HostMediatedGit = true // git_isolation=readonly
	off := basePolicy()       // HostMediatedGit false

	bash := func(cmd string) map[string]any { return map[string]any{"command": cmd} }

	// In readonly mode raw git writes are ALLOWED to run: .git is read-only, so
	// the OS refuses them and nothing changes. Denying here used to cost the whole
	// Bash call - a compound command lost its unrelated work over one git clause -
	// for no security benefit. The explanation now arrives via GitReadonlyAdvice
	// after the fact (see TestGitReadonlyAdvice).
	for _, sub := range []string{
		"git reset --hard HEAD~1",
		"git add -p file.go",
		"git revert abc123",
		"git rebase -i HEAD~3",
		"git cherry-pick def456",
		"git commit -m x",
		"printf 'x' > a.txt && git add a.txt", // the compound case that motivated this
	} {
		if d := Decide(ro, "Bash", bash(sub)); d.Decision != Allow {
			t.Errorf("readonly %q = %v, want Allow (OS enforces; advice is post-hoc)", sub, d.Decision)
		}
	}
	// The relaxation is scoped to git: readonly does not soften the other
	// tripwires, which guard things the filesystem does not.
	if d := Decide(ro, "Bash", bash("git push origin main")); d.Decision != Deny {
		t.Errorf("readonly git push = %v, want Deny (leaves the sandbox)", d.Decision)
	}
	// Reads still work in readonly.
	for _, sub := range []string{"git status", "git log --oneline", "git diff", "git show HEAD"} {
		if d := Decide(ro, "Bash", bash(sub)); d.Decision != Allow {
			t.Errorf("readonly read %q = %v, want Allow", sub, d.Decision)
		}
	}
	// In off mode the redirect doesn't fire: git reset/add run in the shell
	// (only commit stays gate-denied everywhere).
	if d := Decide(off, "Bash", bash("git reset --hard HEAD~1")); d.Decision != Allow {
		t.Errorf("off-mode git reset = %v, want Allow (redirect is readonly-only)", d.Decision)
	}
	if d := Decide(off, "Bash", bash("git add -A")); d.Decision != Allow {
		t.Errorf("off-mode git add = %v, want Allow", d.Decision)
	}
	if d := Decide(off, "Bash", bash("git commit -m x")); d.Decision != Deny {
		t.Errorf("off-mode git commit = %v, want Deny (always)", d.Decision)
	}
}

func TestGitReadonlyAdvice(t *testing.T) {
	const roErr = "fatal: cannot lock ref 'refs/heads/x': Unable to create '/repo/.git/refs/heads/x.lock': Read-only file system"

	// A git write that hit the read-only .git gets the matching tool named.
	if got := GitReadonlyAdvice("git commit -m x", roErr); !strings.Contains(got, "git_commit") {
		t.Errorf("commit advice should name git_commit, got %q", got)
	}
	if got := GitReadonlyAdvice("git cherry-pick abc", roErr); !strings.Contains(got, "git_cherry_pick") {
		t.Errorf("cherry-pick advice should name git_cherry_pick, got %q", got)
	}
	// A git write with no tool equivalent still gets explained - these previously
	// hit the same wall with no pointer at all.
	got := GitReadonlyAdvice("git stash", roErr)
	if !strings.Contains(got, "read-only") || !strings.Contains(got, "mcp__hydra__git_") {
		t.Errorf("uncovered git write should still be explained, got %q", got)
	}
	// Silent when there is nothing to explain: a git command that worked, or a
	// read-only-filesystem error from something that was not git.
	if got := GitReadonlyAdvice("git commit -m x", "[main abc1234] x\n 1 file changed"); got != "" {
		t.Errorf("successful git should get no advice, got %q", got)
	}
	if got := GitReadonlyAdvice("touch /etc/passwd", roErr); got != "" {
		t.Errorf("non-git read-only error should get no git advice, got %q", got)
	}
}

func TestShellCwdAdvice(t *testing.T) {
	const wt = "/repo/.hydra/local/worktrees/head"

	// The whole point: the shell is somewhere other than where the agent assumes.
	after := ShellCwdAdviceAfter(wt+"/web", wt)
	if !strings.Contains(after, wt+"/web") {
		t.Errorf("after-advice should name the directory the shell is in, got %q", after)
	}
	if !strings.Contains(after, "persistent") {
		t.Errorf("after-advice should say the cwd carries into the next call, got %q", after)
	}
	// The before-note is the one that survives a failing call, so it has to stand
	// on its own - and read as "where you are", not "where you ended up".
	before := ShellCwdAdviceBefore(wt+"/web", wt)
	if !strings.Contains(before, wt+"/web") {
		t.Errorf("before-advice should name the directory the shell is in, got %q", before)
	}
	if before == after {
		t.Errorf("the two notes ride the same call and must not read as a stuck record: %q", before)
	}
	// At the root there is nothing to correct, and these fire on every Bash call -
	// so silence there is what keeps them from being noise. Fail silent rather than
	// guess, too: an unseeded HYDRA_WORKTREE or a payload with no cwd (a non-Claude
	// hook shape) leaves nothing to compare against.
	for _, tc := range []struct{ name, cwd, root string }{
		{"at the worktree root", wt, wt},
		{"unknown worktree root", wt + "/web", ""},
		{"unknown cwd", "", wt},
	} {
		if got := ShellCwdAdviceAfter(tc.cwd, tc.root); got != "" {
			t.Errorf("%s should get no after-advice, got %q", tc.name, got)
		}
		if got := ShellCwdAdviceBefore(tc.cwd, tc.root); got != "" {
			t.Errorf("%s should get no before-advice, got %q", tc.name, got)
		}
	}
}

// A raw `git merge` that hit the read-only .git is pointed at the merge tools,
// so the agent's next move is the sanctioned one rather than another retry.
func TestGitReadonlyAdviceNamesMergeTool(t *testing.T) {
	roErr := "fatal: update_ref failed for ref 'ORIG_HEAD': cannot lock ref 'ORIG_HEAD': Unable to create '/x/.git/ORIG_HEAD.lock': Read-only file system"
	got := GitReadonlyAdvice("git merge main --no-edit", roErr)
	if !strings.Contains(got, "git_merge") {
		t.Errorf("merge advice should name git_merge, got %q", got)
	}
	if !strings.Contains(got, "git_merge_abort") {
		t.Errorf("merge advice should mention the continue/abort pair, got %q", got)
	}
}
