package gate

import "testing"

func basePolicy() Policy {
	return Policy{
		GateEnabled:        true,
		MCPAllowed:         []string{"github"},
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
		// A bare mention of the tamper keys (no write) is allowed — e.g. a commit
		// message describing the gate, or echoing the key name.
		{"bash commit msg mentioning key allowed", "Bash", map[string]any{"command": `git commit -m "gate: deny disableAllHooks writes to .claude/settings.json"`}, Allow},
		{"bash echo key no write allowed", "Bash", map[string]any{"command": "echo checking for disableAllHooks"}, Allow},
		{"bash write tamper key denied", "Bash", map[string]any{"command": `printf disableAllHooks >> /tmp/x`}, Deny},
		{"write managed settings denied", "Write", map[string]any{"file_path": "/etc/claude-code/managed-settings.json"}, Deny},
		{"bash git push asks", "Bash", map[string]any{"command": "git push origin main"}, Ask},
		{"bash git push dry-run allowed", "Bash", map[string]any{"command": "git push --dry-run"}, Allow},
		{"bash normal allowed", "Bash", map[string]any{"command": "go test ./..."}, Allow},
		{"unrecognized tool allowed", "SomeNewTool", map[string]any{"x": "y"}, Allow},
		{"websearch allowed", "WebSearch", map[string]any{"query": "x"}, Allow},
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

func TestDecideAskCarriesTarget(t *testing.T) {
	p := basePolicy()
	if r := Decide(p, "mcp__evil__run", nil); r.Kind != "mcp" || r.Target != "evil" {
		t.Errorf("mcp ask target: kind=%q target=%q", r.Kind, r.Target)
	}
	if r := Decide(p, "WebFetch", map[string]any{"url": "https://evil.test/x"}); r.Kind != "webfetch" || r.Target != "evil.test" {
		t.Errorf("webfetch ask target: kind=%q target=%q", r.Kind, r.Target)
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
