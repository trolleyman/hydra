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

func TestReviewToolsHiddenWhenUnwired(t *testing.T) {
	deps := Deps{ListAvailable: func() []Candidate { return nil }, RequestAccess: func(string) (bool, string) { return false, "" }}
	resps := runLines(t, deps, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	tools := resps[0]["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 2 {
		t.Errorf("expected 2 tools without GetReview, got %d", len(tools))
	}
}
