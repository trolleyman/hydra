package mcpserver

import (
	"encoding/json"
	"strings"
	"testing"
)

// runLines feeds newline-delimited JSON-RPC requests through the server and
// returns the decoded responses (one per line written).
func runLines(t *testing.T, deps Deps, requests ...string) []map[string]any {
	t.Helper()
	in := strings.NewReader(strings.Join(requests, "\n") + "\n")
	var out strings.Builder
	if err := Run(deps, in, &out); err != nil {
		t.Fatalf("Run: %v", err)
	}
	var resps []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("bad response line %q: %v", line, err)
		}
		resps = append(resps, m)
	}
	return resps
}

func TestInitializeAndToolsList(t *testing.T) {
	deps := Deps{
		ListAvailable: func() []Candidate { return nil },
		RequestAccess: func(string) (bool, string) { return false, "" },
	}
	resps := runLines(t, deps,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`, // notification: no response
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
	)
	if len(resps) != 2 {
		t.Fatalf("expected 2 responses (notification suppressed), got %d: %v", len(resps), resps)
	}
	if resps[0]["result"].(map[string]any)["protocolVersion"] != protocolVersion {
		t.Errorf("initialize protocolVersion missing/wrong: %v", resps[0])
	}
	tools := resps[1]["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(tools))
	}
	names := map[string]bool{}
	for _, tl := range tools {
		names[tl.(map[string]any)["name"].(string)] = true
	}
	if !names["list_available_mcp_servers"] || !names["request_mcp_server"] {
		t.Errorf("missing expected tools: %v", names)
	}
}

func TestFocusedGitCatalogHidesDiscoveryAndDeniedOperations(t *testing.T) {
	deps := Deps{
		HideDiscovery: true,
		GitOp:         func(GitOpRequest) GitOpResult { return GitOpResult{OK: true} },
		GitAllowed:    func(operation string) bool { return operation == "checkout" || operation == "commit" },
	}
	names := toolNames(toolDefs(deps))
	if strings.Join(names, ",") != "git_checkout,git_commit" {
		t.Fatalf("focused catalog = %v", names)
	}
	response := runLines(t, deps, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"git_reset","arguments":{}}}`)
	if response[0]["result"].(map[string]any)["isError"] != true {
		t.Fatal("a hidden Git operation must also be rejected if called directly")
	}
}

func TestListAvailableTool(t *testing.T) {
	deps := Deps{
		ListAvailable: func() []Candidate {
			return []Candidate{{Name: "sentry", Source: "project"}}
		},
	}
	resps := runLines(t, deps, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_available_mcp_servers","arguments":{}}}`)
	text := firstText(t, resps[0])
	if !strings.Contains(text, "sentry") {
		t.Errorf("list output missing server: %q", text)
	}
}

func TestRequestAccessApprovedAndDenied(t *testing.T) {
	var requested string
	deps := Deps{
		RequestAccess: func(name string) (bool, string) {
			requested = name
			if name == "good" {
				return true, "approved: good is now allow-listed"
			}
			return false, "denied by user"
		},
	}
	// Approved.
	resps := runLines(t, deps, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"request_mcp_server","arguments":{"name":"good"}}}`)
	if requested != "good" {
		t.Errorf("RequestAccess called with %q, want good", requested)
	}
	if got := resps[0]["result"].(map[string]any)["isError"]; got != false {
		t.Errorf("approved request should not be isError, got %v", got)
	}

	// Denied → isError true.
	resps = runLines(t, deps, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"request_mcp_server","arguments":{"name":"bad"}}}`)
	if got := resps[0]["result"].(map[string]any)["isError"]; got != true {
		t.Errorf("denied request should be isError, got %v", got)
	}

	// Empty name → validation error, RequestAccess not called.
	requested = ""
	resps = runLines(t, deps, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"request_mcp_server","arguments":{}}}`)
	if requested != "" {
		t.Errorf("empty name should not call RequestAccess, called with %q", requested)
	}
	if got := resps[0]["result"].(map[string]any)["isError"]; got != true {
		t.Errorf("empty name should be isError, got %v", got)
	}
}

func TestRequestReadAccessAdvertisedValidatedAndCalled(t *testing.T) {
	if names := toolNames(toolDefs(Deps{})); contains(names, "request_read_access") {
		t.Fatalf("request_read_access should be hidden without an approval channel: %v", names)
	}
	var gotPath, gotWhy string
	deps := Deps{RequestReadAccess: func(path, why string) (bool, string) {
		gotPath, gotWhy = path, why
		return true, "approved"
	}}
	if names := toolNames(toolDefs(deps)); !contains(names, "request_read_access") {
		t.Fatalf("request_read_access missing when wired: %v", names)
	}
	resps := runLines(t, deps, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"request_read_access","arguments":{"path":" /opt/sdk ","why":" inspect headers "}}}`)
	if gotPath != "/opt/sdk" || gotWhy != "inspect headers" {
		t.Fatalf("request args = %q, %q", gotPath, gotWhy)
	}
	if resps[0]["result"].(map[string]any)["isError"] != false {
		t.Fatal("approved request should succeed")
	}
	resps = runLines(t, deps, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"request_read_access","arguments":{"path":"/opt/sdk"}}}`)
	if resps[0]["result"].(map[string]any)["isError"] != true {
		t.Fatal("missing why should fail")
	}
}

func TestUnknownMethod(t *testing.T) {
	resps := runLines(t, Deps{}, `{"jsonrpc":"2.0","id":1,"method":"bogus/method"}`)
	if resps[0]["error"] == nil {
		t.Errorf("unknown method should return an error, got %v", resps[0])
	}
}

func firstText(t *testing.T, resp map[string]any) string {
	t.Helper()
	content := resp["result"].(map[string]any)["content"].([]any)
	return content[0].(map[string]any)["text"].(string)
}

func TestReviewToolsAdvertisedAndCalled(t *testing.T) {
	rf := &ReviewFile{
		Linked: true, URL: "https://gl/mr/7", ID: "7", Provider: "gitlab",
		TargetBranch: "main", State: "open", CIStatus: "running",
		Approvals: 1, ApprovalsRequired: 2, UnresolvedDiscussions: 1,
		Comments: []ReviewComment{{Author: "alice", Body: "please rename", Path: "a.go", Line: 12}},
	}
	deps := Deps{
		ListAvailable: func() []Candidate { return nil },
		RequestAccess: func(string) (bool, string) { return false, "" },
		GetReview:     func() *ReviewFile { return rf },
	}
	resps := runLines(t, deps,
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_review_status"}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_review_comments"}}`,
	)
	tools := resps[0]["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 4 {
		t.Fatalf("expected 4 tools with GetReview wired, got %d", len(tools))
	}
	statusText := resps[1]["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(statusText, "https://gl/mr/7") || !strings.Contains(statusText, "1/2") {
		t.Errorf("get_review_status text unexpected: %q", statusText)
	}
	commentsText := resps[2]["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(commentsText, "a.go:12") || !strings.Contains(commentsText, "please rename") {
		t.Errorf("get_review_comments text unexpected: %q", commentsText)
	}
}

func TestGitCommitToolAdvertisedAndCalled(t *testing.T) {
	var calls []GitOpRequest
	deps := Deps{
		ListAvailable: func() []Candidate { return nil },
		RequestAccess: func(string) (bool, string) { return false, "" },
		GitOp: func(r GitOpRequest) GitOpResult {
			calls = append(calls, r)
			return GitOpResult{OK: true, Message: "Committed abc123 on hydra/x: wip"}
		},
	}
	resps := runLines(t, deps,
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"git_commit","arguments":{"message":"wip","paths":["a.go"]}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"git_commit","arguments":{"message":"  "}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"git_reset","arguments":{"to":"HEAD~1","mode":"soft"}}}`,
	)
	// The git tools are advertised alongside the base tools.
	names := map[string]bool{}
	for _, tl := range resps[0]["result"].(map[string]any)["tools"].([]any) {
		names[tl.(map[string]any)["name"].(string)] = true
	}
	for _, n := range []string{"git_commit", "git_reset", "git_revert", "git_add", "git_rebase", "git_rebase_continue", "git_rebase_abort", "git_cherry_pick", "git_merge", "git_merge_continue", "git_merge_abort", "git_stash"} {
		if !names[n] {
			t.Errorf("%s not advertised: %v", n, names)
		}
	}
	// The blank-message commit is rejected BEFORE GitOp runs, so only the valid
	// git_commit and git_reset reach the dep.
	if len(calls) != 2 {
		t.Fatalf("GitOp called %d times, want 2 (blank message rejected early): %+v", len(calls), calls)
	}
	if calls[0].Op != "commit" || calls[0].Message != "wip" || len(calls[0].Paths) != 1 || calls[0].Paths[0] != "a.go" {
		t.Errorf("commit routed as %+v, want op=commit message=wip paths=[a.go]", calls[0])
	}
	if calls[1].Op != "reset" || calls[1].To != "HEAD~1" || calls[1].Mode != "soft" {
		t.Errorf("git_reset routed as %+v, want op=reset to=HEAD~1 mode=soft", calls[1])
	}
	if resps[1]["result"].(map[string]any)["isError"] != false {
		t.Errorf("successful commit should not be isError: %v", resps[1])
	}
	if resps[2]["result"].(map[string]any)["isError"] != true {
		t.Errorf("blank message should be isError: %v", resps[2])
	}
}

func TestGitCommitHiddenWhenUnwired(t *testing.T) {
	deps := Deps{ListAvailable: func() []Candidate { return nil }, RequestAccess: func(string) (bool, string) { return false, "" }}
	resps := runLines(t, deps, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"git_commit","arguments":{"message":"x"}}}`)
	if resps[0]["result"].(map[string]any)["isError"] != true {
		t.Errorf("git_commit with nil Commit dep should error: %v", resps[0])
	}
}

func TestGitRebaseOntoArguments(t *testing.T) {
	req, validation := parseGitOp("git_rebase", json.RawMessage(`{
		"base":"old-base",
		"onto":"main",
		"plan":[{"commit":"abc123","action":"pick"}]
	}`))
	if validation != "" {
		t.Fatalf("parseGitOp validation: %s", validation)
	}
	if req.Op != "rebase" || req.Base != "old-base" || req.Onto != "main" || len(req.Plan) != 1 {
		t.Fatalf("git_rebase routed as %+v", req)
	}
}

func TestReviewToolsHiddenWhenUnwired(t *testing.T) {
	deps := Deps{ListAvailable: func() []Candidate { return nil }, RequestAccess: func(string) (bool, string) { return false, "" }}
	resps := runLines(t, deps, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	tools := resps[0]["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 2 {
		t.Errorf("expected 2 tools without GetReview, got %d", len(tools))
	}
}

// The status tools are advertised only when the daemon channel backing them is
// wired. A head without one must not see a tool that could only ever time out.
func TestHeadStatusToolsHiddenWithoutDeps(t *testing.T) {
	resps := runLines(t, Deps{}, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	tools := resps[0]["result"].(map[string]any)["tools"].([]any)
	for _, tl := range tools {
		if n := tl.(map[string]any)["name"].(string); n == "get_head_status" || n == "get_test_logs" {
			t.Errorf("%s advertised with no backing dep", n)
		}
	}
}

func TestHeadStatusTools(t *testing.T) {
	var gotRunner string
	var gotTail int
	deps := Deps{
		HeadStatus: func() (string, bool) { return "## Tests\n- unit: FAILING", true },
		TestLogs: func(runner string, tail int) (string, bool) {
			gotRunner, gotTail = runner, tail
			return "boom", true
		},
	}
	resps := runLines(t, deps,
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_head_status","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_test_logs","arguments":{"runner":"  unit  ","tail":50}}}`,
		// No runner: a tool error that names the way out, not a silent empty log.
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_test_logs","arguments":{}}}`,
	)
	names := map[string]bool{}
	for _, tl := range resps[0]["result"].(map[string]any)["tools"].([]any) {
		names[tl.(map[string]any)["name"].(string)] = true
	}
	if !names["get_head_status"] || !names["get_test_logs"] {
		t.Errorf("status tools not advertised: %v", names)
	}
	if text := firstText(t, resps[1]); !strings.Contains(text, "unit: FAILING") {
		t.Errorf("get_head_status relayed %q", text)
	}
	// The runner name is trimmed before it reaches the host, so a stray space in
	// the model's argument doesn't turn into "no such runner".
	if gotRunner != "unit" || gotTail != 50 {
		t.Errorf("get_test_logs passed runner=%q tail=%d, want \"unit\"/50", gotRunner, gotTail)
	}
	if resps[3]["result"].(map[string]any)["isError"] != true {
		t.Errorf("get_test_logs with no runner should be a tool error: %v", resps[3])
	}
}

func TestAgentCollaborationTools(t *testing.T) {
	var sent []string
	deps := Deps{
		ListAgents: func() (string, bool) { return "id=one", true },
		GetAgent:   func(id string) (string, bool) { return "agent=" + id, true },
		SendAgent: func(target, body, correlation, reply string) (string, bool) {
			sent = []string{target, body, correlation, reply}
			return "queued", true
		},
	}
	resps := runLines(t, deps,
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_agents","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_agent","arguments":{"id":" one "}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"send_agent_message","arguments":{"target":" two ","body":" hi ","correlation_id":"c","in_reply_to":"m"}}}`,
	)
	names := map[string]bool{}
	for _, tl := range resps[0]["result"].(map[string]any)["tools"].([]any) {
		names[tl.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"list_agents", "get_agent", "send_agent_message"} {
		if !names[want] {
			t.Errorf("%s not advertised: %v", want, names)
		}
	}
	if got := firstText(t, resps[2]); got != "agent=one" {
		t.Errorf("get_agent = %q", got)
	}
	if strings.Join(sent, "|") != "two|hi|c|m" {
		t.Errorf("send args = %#v", sent)
	}
}

func TestAgentMessagingHiddenWithoutBackingDep(t *testing.T) {
	deps := Deps{ListAgents: func() (string, bool) { return "", true }, GetAgent: func(string) (string, bool) { return "", true }}
	resps := runLines(t, deps, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	for _, tl := range resps[0]["result"].(map[string]any)["tools"].([]any) {
		if tl.(map[string]any)["name"] == "send_agent_message" {
			t.Fatal("send tool advertised without opt-in dep")
		}
	}
}

// The run tools are the only ones that spend anything, so they must stay hidden
// unless the daemon channel that guards them is wired.
func TestRunToolsHiddenWithoutDeps(t *testing.T) {
	resps := runLines(t, Deps{}, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	for _, tl := range resps[0]["result"].(map[string]any)["tools"].([]any) {
		if n := tl.(map[string]any)["name"].(string); n == "retry_tests" || n == "retry_artifacts" {
			t.Errorf("%s advertised with no backing dep", n)
		}
	}
}

func TestRunTools(t *testing.T) {
	var seen []string
	var artifactCalls []string
	deps := Deps{
		RunTests: func(r string) (string, bool) { seen = append(seen, r); return "Started 1 test runner(s): unit.", true },
		RunArtifacts: func(n string) (string, bool) {
			artifactCalls = append(artifactCalls, n)
			return "Started 1 artifact(s): shots.", true
		},
	}
	resps := runLines(t, deps,
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"retry_tests","arguments":{"runner":"  unit  "}}}`,
		// No argument at all means "all of them" - it must not be an error.
		// Sent under the PRE-RENAME name, which stays dispatchable so a config or
		// a doc quoting it does not break.
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run_tests","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"retry_artifacts","arguments":{"name":"shots"}}}`,
		// Pre-rename name, still dispatchable.
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"generate_artifacts","arguments":{"name":"old"}}}`,
	)
	// The name is trimmed before it reaches the host, and an omitted argument
	// arrives as "" - the "run all of them" form, not an error.
	if len(seen) != 2 || seen[0] != "unit" || seen[1] != "" {
		t.Errorf("retry_tests saw %q, want [\"unit\", \"\"]", seen)
	}
	if resps[0]["result"].(map[string]any)["isError"] != false {
		t.Errorf("retry_tests should not be a tool error: %v", resps[0])
	}
	if text := firstText(t, resps[1]); !strings.Contains(text, "Started") {
		t.Errorf("retry_tests relayed %q", text)
	}
	// Both the new name and the pre-rename one reach the artifact dep.
	if len(artifactCalls) != 2 || artifactCalls[0] != "shots" || artifactCalls[1] != "old" {
		t.Errorf("retry_artifacts saw %q, want [\"shots\", \"old\"]", artifactCalls)
	}
}
