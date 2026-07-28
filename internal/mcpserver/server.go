// Package mcpserver implements a minimal Model Context Protocol (MCP) server that
// Hydra seeds into the agent's own toolset, so the inner agent can DISCOVER MCP
// servers configured on the host and REQUEST access to one at runtime - gated by
// the same approval flow as the security gate. Granting a server appends it to the
// allow-list; because MCP servers are loaded at launch, the new server becomes
// usable on the agent's next launch/resume.
//
// It speaks the MCP stdio transport: newline-delimited JSON-RPC 2.0, one message
// per line on stdin/stdout. Only the handful of methods a tools-only server needs
// are implemented (initialize, tools/list, tools/call, and the initialized
// notification); anything else gets a JSON-RPC "method not found".
package mcpserver

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"

	"braces.dev/errtrace"
)

// protocolVersion is the MCP revision this server advertises in initialize.
const protocolVersion = "2024-11-05"

// Candidate is a host-configured MCP server the agent may request access to.
type Candidate struct {
	Name   string `json:"name"`
	Source string `json:"source"`
}

// Deps are the host-provided behaviours the tools call into, injected so the
// server logic is testable without a sandbox or real files.
type Deps struct {
	// ListAvailable returns candidate servers not yet on the allow-list.
	ListAvailable func() []Candidate
	// RequestAccess submits an approval request for server `name` and blocks until
	// the user decides (or it times out). It returns whether it was approved and a
	// human-readable message to relay to the agent.
	RequestAccess func(name string) (approved bool, message string)
	// GetReview returns this head's current MR link + cached forge state (status,
	// unresolved discussions), or nil when unavailable. Populated from the per-head
	// review file the MR watcher writes; nil disables the review tools.
	// See docs/non-local-integration.md.
	GetReview func() *ReviewFile
	// ReplyLocal records a LOCAL-ONLY reply on one of this head's review threads:
	// visible to the user in Hydra's diff viewer, never sent to the forge. Agents
	// have no forge credentials by design and Hydra only writes to a PR as an
	// explicit user action, so this is the whole of an agent's write access to a
	// review conversation. Nil hides the tool.
	ReplyLocal func(threadID, body string) (ok bool, message string)
	// GitOp performs a git write-operation on the head's OWN branch, inside its
	// worktree - never another branch or a path outside the worktree. It backs the
	// git_* tools (commit / reset / revert / add / rebase / cherry-pick): raw git
	// writes are gate-denied (and in readonly mode .git is read-only), so these are
	// the sanctioned path - a write can't land on the main repo or a sibling head.
	// Nil disables all the git_* tools.
	GitOp func(GitOpRequest) GitOpResult
	// HostRun asks the user to run one command on the HOST, outside the sandbox,
	// in the head's worktree, and blocks until they decide (and, on allow, until
	// the command finishes). The sandbox escape hatch of last resort. Nil - no
	// approval channel - hides the tool rather than letting it fail on use.
	HostRun func(HostRunRequest) HostRunResult
	// HeadStatus returns a rendered summary of this head's own tests, artifacts and
	// services. The daemon owns that state (services exist only in its memory), and
	// it renders the text too, so the wording lives next to the managers it
	// describes. Read-only: it never starts a run. Nil hides the tool.
	HeadStatus func() (message string, ok bool)
	// TestLogs returns the tail of one test runner's captured output for this head.
	// Split from HeadStatus so the common "am I green?" call stays cheap and only a
	// real failure pays for a log. Nil hides the tool.
	TestLogs func(runner string, tail int) (message string, ok bool)
	// RunTests / RunArtifacts discard this head's cached verdicts/outputs for its
	// branch tip and start fresh runs, returning as soon as the work is queued. The
	// only tools here that SPEND anything: the daemon declines a run already in
	// flight or one that just settled, so a loop cannot burn the user's CPU.
	// Nil hides them.
	RunTests     func(runner string) (message string, ok bool)
	RunArtifacts func(name string) (message string, ok bool)
}

// HostRunRequest is one host_run call: the command to run and the agent's
// explanation of why it cannot run inside the sandbox.
type HostRunRequest struct {
	Command string
	Why     string
}

// HostRunResult is what came back: Message is the agent-readable outcome (the
// command's output, or why it never ran), Failed marks it as a tool error.
type HostRunResult struct {
	Failed  bool
	Message string
}

// GitOpRequest is the union input to the git_* tools. Op selects the operation;
// the remaining fields are op-specific (see git.RunGuardedOp for their semantics).
type GitOpRequest struct {
	Op string

	// commit
	Message string
	Paths   []string
	Amend   bool
	Staged  bool

	// reset
	Mode    string
	To      string
	Unstage []string
	Confirm bool

	// add
	Add []GitAddSpec

	// revert / cherry_pick
	Commit string

	// rebase
	Base string
	Plan []GitRebaseStep

	// merge (Message doubles as the merge-commit subject)
	Ref  string
	NoFF bool

	// stash (Message doubles as the stash label on push)
	Stash            string
	StashRef         string
	IncludeUntracked bool
}

// GitAddSpec stages a file, optionally restricted to new-file line ranges.
type GitAddSpec struct {
	Path   string   `json:"path"`
	Ranges [][2]int `json:"ranges,omitempty"`
}

// GitRebaseStep is one step of a plan-based interactive rebase.
type GitRebaseStep struct {
	Commit  string `json:"commit"`
	Action  string `json:"action"`
	Message string `json:"message,omitempty"`
}

// GitOpResult is the outcome of a git_* call: OK plus an agent-readable summary
// (e.g. the new commit's hash/subject) or an error explanation.
type GitOpResult struct {
	OK      bool
	Message string
}

// ReviewFile is the per-head MR snapshot the daemon's MR watcher writes and the
// `hydra mcp` server reads for the review tools. It is this head's MR by
// construction (the file is bound only into this head's sandbox).
type ReviewFile struct {
	Linked                bool            `json:"linked"`
	URL                   string          `json:"url,omitempty"`
	ID                    string          `json:"id,omitempty"`
	Provider              string          `json:"provider,omitempty"`
	TargetBranch          string          `json:"target_branch,omitempty"`
	State                 string          `json:"state,omitempty"`
	CIStatus              string          `json:"ci_status,omitempty"`
	Approvals             int             `json:"approvals,omitempty"`
	ApprovalsRequired     int             `json:"approvals_required,omitempty"`
	UnresolvedDiscussions int             `json:"unresolved_discussions,omitempty"`
	Mergeable             bool            `json:"mergeable,omitempty"`
	Comments              []ReviewComment `json:"comments,omitempty"`
	UpdatedAt             string          `json:"updated_at,omitempty"`
	// StaleReason is set by the loader (not persisted) when it could not confirm
	// this snapshot is current - the on-demand forge refresh failed or timed out.
	// The tools pass it on so the agent knows to treat the answer as possibly
	// out of date rather than acting on "no comments".
	StaleReason string `json:"-"`
}

// ReviewComment is one unresolved review thread with file/line context.
type ReviewComment struct {
	// ID is the thread handle, which reply_to_review_comment takes.
	ID     string `json:"id,omitempty"`
	Author string `json:"author,omitempty"`
	Body   string `json:"body,omitempty"`
	Path   string `json:"path,omitempty"`
	Line   int    `json:"line,omitempty"`
	URL    string `json:"url,omitempty"`
}

// rpcRequest / rpcResponse are the subset of JSON-RPC 2.0 we parse/emit. A
// request with no ID is a notification (no response is written).
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Run reads JSON-RPC messages from in and writes responses to out until in is
// exhausted (the client closed the pipe). Each line is one message.
func Run(deps Deps, in io.Reader, out io.Writer) error {
	sc := bufio.NewScanner(in)
	// MCP messages can be large (a tools/list with many schemas); raise the line cap.
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	enc := json.NewEncoder(out)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			// Can't recover an ID from an unparseable line; skip it.
			continue
		}
		resp, respond := dispatch(deps, req)
		if !respond {
			continue
		}
		if err := enc.Encode(resp); err != nil {
			return errtrace.Wrap(err)
		}
	}
	return errtrace.Wrap(sc.Err())
}

// dispatch routes one request to its handler, returning the response and whether
// a response should be written (notifications produce none).
func dispatch(deps Deps, req rpcRequest) (rpcResponse, bool) {
	// Notifications (no ID) are acknowledged silently.
	if len(req.ID) == 0 {
		return rpcResponse{}, false
	}
	base := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		base.Result = map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "hydra", "version": "1"},
		}
	case "ping":
		base.Result = map[string]any{}
	case "tools/list":
		base.Result = map[string]any{"tools": toolDefs(deps)}
	case "tools/call":
		base.Result = callTool(deps, req.Params)
	default:
		base.Error = &rpcError{Code: -32601, Message: "method not found: " + req.Method}
	}
	return base, true
}

// toolDefs is the advertised tool catalog (tools/list). The review tools are
// advertised only when GetReview is wired (a review-capable head).
func toolDefs(deps Deps) []map[string]any {
	defs := []map[string]any{
		{
			"name":        "list_available_mcp_servers",
			"description": "List MCP servers configured on the host that are NOT yet available to you. Use this to discover tools you could request access to.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
			"annotations": map[string]any{"readOnlyHint": true},
		},
		{
			"name":        "request_mcp_server",
			"description": "Request access to a host-configured MCP server by name. This asks the user to approve it; if granted, the server is added to your allow-list and becomes available after your session reloads. Only servers from list_available_mcp_servers can be requested.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"name"},
				"properties": map[string]any{
					"name": map[string]any{"type": "string", "description": "The MCP server name to request."},
				},
			},
		},
	}
	if deps.GitOp != nil {
		defs = append(defs, gitToolDefs()...)
	}
	if deps.HostRun != nil {
		defs = append(defs, hostRunToolDef())
	}
	if deps.HeadStatus != nil {
		defs = append(defs, map[string]any{
			"name": "get_head_status",
			"description": "Get the status of YOUR OWN work as Hydra sees it: the verdict of each configured test runner - with the failing cases NAMED and their failure messages included, so this is usually all you need to start fixing - plus the state of each artifact/screenshot set and the project's supervised services. " +
				"This is the same state the user is looking at in Hydra's panels, and the test verdicts are what the merge and publish gates check - so this, not your own ad-hoc test command, is the answer to \"am I green?\". " +
				"Everything is measured against your branch's latest COMMIT, so commit before calling it if you want your newest work judged. " +
				"Read-only and cheap: it reports cached results and never starts a test run or a generation.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
			"annotations": map[string]any{"readOnlyHint": true},
		})
	}
	if deps.TestLogs != nil {
		defs = append(defs, map[string]any{
			"name": "get_test_logs",
			"description": "Get the captured output of ONE of your test runners' latest run, for when get_head_status is not enough - it already gives you the failing case names and their messages, so reach for this only if you need the surrounding output (a stack trace, a build error, the cases it had to truncate). " +
				"Take the runner name from get_head_status; call that first rather than guessing one. " +
				"Returns the END of the log (where a failure almost always is), 200 lines by default - raise \"tail\" only if the answer is genuinely cut off, since a long log costs you context you could spend fixing the test.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"runner"},
				"properties": map[string]any{
					"runner": map[string]any{"type": "string", "description": "The test runner's name, as reported by get_head_status."},
					"tail":   map[string]any{"type": "integer", "description": "How many lines from the END of the log to return. Default 200, maximum 2000."},
				},
			},
			"annotations": map[string]any{"readOnlyHint": true},
		})
	}
	if deps.RunTests != nil {
		defs = append(defs, map[string]any{
			"name": "run_tests",
			"description": "Re-run YOUR test runners against your branch's latest commit, discarding the cached verdict - use it after committing a fix, when get_head_status still shows the old result. " +
				"Runs Hydra's own configured runner, which is the one that gates your merge; that is often NOT reproducible with your own shell command (it runs in a separate checkout, and may need host access or network you do not have). " +
				"Returns as soon as the run STARTS, not when it finishes: call get_head_status a little later for the verdict, and do NOT call this again while it runs. " +
				"COMMIT FIRST - it tests the latest commit, not your working tree.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"runner": map[string]any{"type": "string", "description": "One runner's name, as reported by get_head_status. Omit to run all of them."},
				},
			},
		})
	}
	if deps.RunArtifacts != nil {
		defs = append(defs, map[string]any{
			"name": "generate_artifacts",
			"description": "Regenerate YOUR artifacts (screenshots and other generated outputs) from your branch's latest commit, discarding the cached ones. " +
				"Useful after a UI change: regenerate, then read the image files get_head_status lists to see what your change actually looks like. " +
				"Returns as soon as generation STARTS: call get_head_status a little later for the files, and do NOT call this again while it runs. " +
				"COMMIT FIRST - it builds from the latest commit, not your working tree.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name": map[string]any{"type": "string", "description": "One artifact set's name, as reported by get_head_status. Omit to regenerate all of them."},
				},
			},
		})
	}
	if deps.GetReview != nil {
		defs = append(defs,
			map[string]any{
				"name":        "get_review_status",
				"description": "Get the status of YOUR merge/pull request, if this head is linked to one: URL, target branch, draft/open/merged state, CI status, approvals, and the count of unresolved review discussions. Reads the MR from the forge on every call (a second or two), so the answer is live - call it again whenever you need current state. Scoped to this head's own MR only.",
				"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
				"annotations": map[string]any{"readOnlyHint": true},
			},
			map[string]any{
				"name":        "get_review_comments",
				"description": "Get YOUR merge/pull request's unresolved review discussions with file/line context, ready to act on. Reads the MR from the forge on every call (a second or two), so it picks up comments left while you were working - call it again after a push. Use this to address reviewer feedback, then commit your changes.",
				"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
				"annotations": map[string]any{"readOnlyHint": true},
			},
		)
		if deps.ReplyLocal != nil {
			defs = append(defs, map[string]any{
				"name": "reply_to_review_comment",
				"description": "Reply to one review discussion on YOUR merge/pull request, for the USER to read in Hydra's diff viewer. " +
					"The reply is LOCAL ONLY - it is never posted to the forge, so the reviewer will not see it; the user decides what to send on. " +
					"Use it to say what you changed and why, or to disagree with a comment, next to the thread it answers. Take the thread id from get_review_comments.",
				"inputSchema": map[string]any{
					"type":     "object",
					"required": []string{"thread_id", "body"},
					"properties": map[string]any{
						"thread_id": map[string]any{"type": "string", "description": "The discussion's thread id, as given by get_review_comments."},
						"body":      map[string]any{"type": "string", "description": "Your reply, in markdown."},
					},
				},
			})
		}
	}
	return defs
}

// callTool dispatches a tools/call by name and returns an MCP tool result
// (a content array; isError marks a failure).
func callTool(deps Deps, params json.RawMessage) map[string]any {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	_ = json.Unmarshal(params, &p)
	switch p.Name {
	case "list_available_mcp_servers":
		return textResult(listAvailableText(deps), false)
	case "request_mcp_server":
		var args struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(p.Arguments, &args)
		if args.Name == "" {
			return textResult("request_mcp_server requires a non-empty \"name\".", true)
		}
		approved, msg := deps.RequestAccess(args.Name)
		return textResult(msg, !approved)
	case "git_commit", "git_reset", "git_revert", "git_add", "git_rebase", "git_rebase_continue", "git_rebase_abort", "git_cherry_pick",
		"git_merge", "git_merge_continue", "git_merge_abort", "git_stash":
		if deps.GitOp == nil {
			return textResult(p.Name+" is not available in this session.", true)
		}
		req, errMsg := parseGitOp(p.Name, p.Arguments)
		if errMsg != "" {
			return textResult(errMsg, true)
		}
		r := deps.GitOp(req)
		return textResult(r.Message, !r.OK)
	case "host_run":
		if deps.HostRun == nil {
			return textResult("host_run is not available in this session (no approval channel).", true)
		}
		hr, errMsg := parseHostRun(p.Arguments)
		if errMsg != "" {
			return textResult(errMsg, true)
		}
		r := deps.HostRun(hr)
		return textResult(r.Message, r.Failed)
	case "get_head_status":
		if deps.HeadStatus == nil {
			return textResult("get_head_status is not available in this session.", true)
		}
		msg, ok := deps.HeadStatus()
		return textResult(msg, !ok)
	case "get_test_logs":
		if deps.TestLogs == nil {
			return textResult("get_test_logs is not available in this session.", true)
		}
		var args struct {
			Runner string `json:"runner"`
			Tail   int    `json:"tail"`
		}
		_ = json.Unmarshal(p.Arguments, &args)
		if strings.TrimSpace(args.Runner) == "" {
			return textResult("get_test_logs needs a \"runner\". Call get_head_status to see which runners this project configures.", true)
		}
		msg, ok := deps.TestLogs(strings.TrimSpace(args.Runner), args.Tail)
		return textResult(msg, !ok)
	case "run_tests", "generate_artifacts":
		fn, argKey := deps.RunTests, "runner"
		if p.Name == "generate_artifacts" {
			fn, argKey = deps.RunArtifacts, "name"
		}
		if fn == nil {
			return textResult(p.Name+" is not available in this session.", true)
		}
		var args map[string]any
		_ = json.Unmarshal(p.Arguments, &args)
		target, _ := args[argKey].(string)
		msg, ok := fn(strings.TrimSpace(target))
		return textResult(msg, !ok)
	case "get_review_status":
		return textResult(reviewStatusText(deps), false)
	case "get_review_comments":
		return textResult(reviewCommentsText(deps), false)
	case "reply_to_review_comment":
		if deps.ReplyLocal == nil {
			return textResult("reply_to_review_comment is not available in this session.", true)
		}
		var args struct {
			ThreadID string `json:"thread_id"`
			Body     string `json:"body"`
		}
		_ = json.Unmarshal(p.Arguments, &args)
		if strings.TrimSpace(args.ThreadID) == "" || strings.TrimSpace(args.Body) == "" {
			return textResult("reply_to_review_comment needs a non-empty \"thread_id\" and \"body\".", true)
		}
		ok, msg := deps.ReplyLocal(args.ThreadID, args.Body)
		if msg == "" && ok {
			msg = "Saved as a local note on that discussion. The user can see it in Hydra next to the thread; it was NOT posted to the forge."
		}
		return textResult(msg, !ok)
	default:
		return textResult("unknown tool: "+p.Name, true)
	}
}

// unlinkedText explains an unlinked head to the agent. It names the two ways a
// head gets a PR (adopted at spawn, or published later) so the agent asks the
// user instead of reaching for `gh`/`glab`, which are unauthenticated in the
// sandbox - every forge call runs host-side in the daemon.
const unlinkedText = "This head is not linked to a merge/pull request: it was not spawned onto an existing PR, and it has not been published yet. " +
	"`gh`/`glab` are not authenticated inside the sandbox, so there is no other way to reach the forge from here - " +
	"ask the user to publish this head (or to respawn it onto the PR) from Hydra's UI."

// reviewStatusText renders this head's MR status for get_review_status.
func reviewStatusText(deps Deps) string {
	if deps.GetReview == nil {
		return unlinkedText
	}
	rf := deps.GetReview()
	if rf == nil || !rf.Linked {
		return unlinkedText
	}
	var b strings.Builder
	b.WriteString("Your merge/pull request:\n")
	b.WriteString("- URL: " + rf.URL + "\n")
	b.WriteString("- Provider: " + rf.Provider + " (id " + rf.ID + ")\n")
	if rf.TargetBranch != "" {
		b.WriteString("- Target branch: " + rf.TargetBranch + "\n")
	}
	if rf.State != "" {
		b.WriteString("- State: " + rf.State + "\n")
	}
	if rf.CIStatus != "" && rf.CIStatus != "none" {
		b.WriteString("- CI: " + rf.CIStatus + "\n")
	}
	if rf.ApprovalsRequired > 0 {
		b.WriteString("- Approvals: " + itoa(rf.Approvals) + "/" + itoa(rf.ApprovalsRequired) + "\n")
	}
	b.WriteString("- Unresolved discussions: " + itoa(rf.UnresolvedDiscussions) + "\n")
	if rf.UpdatedAt != "" {
		b.WriteString("- Fetched from the forge at: " + rf.UpdatedAt + "\n")
	}
	b.WriteString(freshnessNote(rf))
	if rf.UnresolvedDiscussions > 0 {
		b.WriteString("Use get_review_comments to read the unresolved discussions.\n")
	}
	return b.String()
}

// freshnessNote tells the agent how much to trust the snapshot's age. Each tool
// call asks the daemon to re-read the MR first, so the normal case is "this is
// live"; StaleReason is set only when that refresh could not be completed.
func freshnessNote(rf *ReviewFile) string {
	if rf.StaleReason != "" {
		return "NOTE: " + rf.StaleReason + "\n"
	}
	return ""
}

// reviewCommentsText renders this head's unresolved discussions for
// get_review_comments.
func reviewCommentsText(deps Deps) string {
	if deps.GetReview == nil {
		return unlinkedText
	}
	rf := deps.GetReview()
	if rf == nil || !rf.Linked {
		return unlinkedText
	}
	if len(rf.Comments) == 0 {
		msg := "No unresolved review discussions on " + rf.URL
		if rf.UpdatedAt != "" {
			msg += " as of " + rf.UpdatedAt
		}
		return msg + ".\n" + freshnessNote(rf)
	}
	var b strings.Builder
	b.WriteString(freshnessNote(rf))
	b.WriteString("Unresolved review discussions on your MR (address them, then commit):\n\n")
	for i, c := range rf.Comments {
		b.WriteString(itoa(i + 1))
		b.WriteString(". ")
		if c.Path != "" {
			b.WriteString(c.Path)
			if c.Line > 0 {
				b.WriteString(":" + itoa(c.Line))
			}
			b.WriteString(" ")
		}
		if c.Author != "" {
			b.WriteString("(@" + c.Author + ") ")
		}
		if c.ID != "" {
			b.WriteString("[thread " + c.ID + "]")
		}
		b.WriteString("\n   ")
		b.WriteString(strings.ReplaceAll(strings.TrimSpace(c.Body), "\n", "\n   "))
		b.WriteString("\n")
	}
	if deps.ReplyLocal != nil {
		b.WriteString("\nUse reply_to_review_comment with a thread id to answer one of these for the USER to read in Hydra (local only - it is not posted to the forge).\n")
	}
	return b.String()
}

// itoa is a tiny strconv.Itoa avoiding the import for one call site.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// listAvailableText renders the available-server list as human/agent-readable text.
func listAvailableText(deps Deps) string {
	servers := deps.ListAvailable()
	if len(servers) == 0 {
		return "No additional MCP servers are available to request. You already have access to every server the host has configured."
	}
	var b strings.Builder
	b.WriteString("MCP servers you can request access to (use request_mcp_server with the name):\n")
	for _, s := range servers {
		b.WriteString("- ")
		b.WriteString(s.Name)
		b.WriteString(" (")
		b.WriteString(s.Source)
		b.WriteString(")\n")
	}
	return b.String()
}

// textResult wraps text in the MCP tool-result content shape.
func textResult(text string, isError bool) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": isError,
	}
}
