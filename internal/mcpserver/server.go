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
	// ReplyLocal records a LOCAL-ONLY reply to a review comment, addressed by its
	// NUMBER - the one sequence covering Hydra's own comments and the forge's
	// alike, so an agent answers "#7" without needing to know where #7 lives.
	// Visible to the user in Hydra's diff viewer, never sent to the forge: agents
	// have no forge credentials by design and Hydra only writes to a PR as an
	// explicit user action, so this is the whole of an agent's write access to a
	// review conversation. Nil hides the tool.
	ReplyLocal func(number int, body string) (ok bool, message string)
	// HydraComments reads Hydra's OWN review comments on this head - numbered,
	// line-anchored, and durable, so an agent can re-read "#3" rounds later
	// instead of relying on a blob that was pasted into its context and has since
	// scrolled out (docs/review-agent.md). Published only; drafts never reach an
	// agent. numbers narrows the read; empty means all. Nil hides the tool.
	HydraComments func(numbers []int) (message string, ok bool)
	// AddComment leaves a review comment anchored to a file and line, for the user
	// (and any other agent) to read in the diff viewer. Nil hides the tool.
	AddComment func(path string, line int, replyTo int, body string) (message string, ok bool)
	// ResolveComments marks review comments dealt with (reopen inverts it), by the
	// same numbering the read and reply tools use. The agent that just did the work
	// is the only one that knows a comment is finished, so without this the open
	// list only ever grows. Local to Hydra: a forge thread is never resolved on the
	// forge, since agents have no forge credentials by design. Nil hides the tool.
	ResolveComments func(numbers []int, reopen bool) (message string, ok bool)
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
	// ID is the thread handle a local reply attaches to.
	ID string `json:"id,omitempty"`
	// Number is this comment's handle in the head's ONE numbering sequence, shared
	// with Hydra's own comments so an agent can say "#7" and mean exactly one
	// thing regardless of which side of the fence it was written on. It is also
	// what reply_to_review_comment takes.
	Number int    `json:"number,omitempty"`
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
	// One tool for both sources of review feedback. They are the same job to an
	// agent - "what has someone said about my code, and where" - so splitting them
	// by where they happen to be stored would only make the model pick, and pick
	// wrong. Comments left IN Hydra need no forge at all, which is why this is not
	// nested under GetReview.
	if deps.GetReview != nil || deps.HydraComments != nil {
		defs = append(defs, map[string]any{
			"name": "get_review_comments",
			"description": "Read the review comments on YOUR work, with file/line context, ready to act on. Covers both: comments left in Hydra by the user or a reviewer agent (numbered - refer to them as \"#3\" from then on), and, if this head is linked to a merge/pull request, that MR's unresolved discussions read live from the forge. " +
				"Hydra tells you when comments arrive by NUMBER only, so this is how you read what they say - and you can call it again rounds later to check whether something you were asked about still stands. " +
				"A comment may be pinned to a POINT ON A PICTURE rather than a line of code - one left on a generated artifact (a screenshot). Those carry the image's path on this machine, the pixel coordinates of the pin, and which commit the picture was rendered from: OPEN THE IMAGE and look at that spot before acting, rather than guessing from the coordinates. " +
				"When a pin says it was rendered from the uncommitted working tree, git cannot tell you what has changed since - regenerate the artifact and compare instead.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"numbers": map[string]any{
						"type":        "array",
						"items":       map[string]any{"type": "integer"},
						"description": "Read only these Hydra comment numbers, in full, with their diff context. Omit for everything (without the per-comment diff blocks, which keeps a habitual call cheap).",
					},
				},
			},
			"annotations": map[string]any{"readOnlyHint": true},
		})
	}
	if deps.AddComment != nil {
		defs = append(defs, map[string]any{
			"name": "add_review_comment",
			"description": "Leave a review comment anchored to a line of this head's diff, for the USER to read in Hydra's diff viewer next to the code it is about. " +
				"It is durable and numbered, so you (or another agent) can refer back to it as \"#4\" later. It is LOCAL to Hydra and is never posted to a forge. " +
				"Prefer one specific, located comment over a paragraph in chat: chat scrolls away, this stays attached to the line.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"body"},
				"properties": map[string]any{
					"path":     map[string]any{"type": "string", "description": "Repo-relative file the comment is about."},
					"line":     map[string]any{"type": "integer", "description": "Line number in the CURRENT version of that file."},
					"reply_to": map[string]any{"type": "integer", "description": "Reply to an existing comment by its number, rather than opening a new one. Prefer this to restating a point already made."},
					"body":     map[string]any{"type": "string", "description": "What you want to say, in markdown."},
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
		)
	}
	if deps.ReplyLocal != nil {
		defs = append(defs, map[string]any{
			"name": "reply_to_review_comment",
			"description": "Reply to one review comment on YOUR OWN diff, by its number, for the USER to read in Hydra next to the comment it answers. " +
				"Works for any comment get_review_comments shows you - one left in Hydra or one on your merge/pull request - because they share one numbering. " +
				"The reply is LOCAL ONLY: it is never posted to the forge, so an outside reviewer will not see it; the user decides what to send on. " +
				"Use it to say what you changed and why, or to disagree, rather than burying the answer in chat where it is not attached to anything.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"number", "body"},
				"properties": map[string]any{
					"number": map[string]any{"type": "integer", "description": "The comment's number, as given by get_review_comments (the \"#7\" handle)."},
					"body":   map[string]any{"type": "string", "description": "Your reply, in markdown."},
				},
			},
		})
	}
	if deps.ResolveComments != nil {
		defs = append(defs, map[string]any{
			"name": "resolve_review_comments",
			"description": "Mark review comments on YOUR OWN diff as dealt with, by their numbers, so they drop off the user's open list. " +
				"Do this once the work a comment asked for is actually committed - you are the only one who knows that, and a list nobody closes only ever grows. " +
				"Say what you did first (reply_to_review_comment), then resolve: a comment that vanishes with no answer leaves the user unable to check your reasoning. " +
				"Do NOT resolve one you disagreed with or decided not to act on - reply and leave it open for the user to decide. " +
				"Works for any comment get_review_comments shows you, since Hydra's own comments and your merge/pull request's share one numbering, but it is LOCAL to Hydra: nothing is resolved on the forge.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"numbers"},
				"properties": map[string]any{
					"numbers": map[string]any{
						"type":        "array",
						"items":       map[string]any{"type": "integer"},
						"description": "The comment numbers you are done with, as given by get_review_comments.",
					},
					"reopen": map[string]any{"type": "boolean", "description": "Put these back on the open list instead - for undoing a resolve you made too early."},
				},
			},
		})
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
		var args struct {
			Numbers []int `json:"numbers"`
		}
		_ = json.Unmarshal(p.Arguments, &args)
		return textResult(reviewCommentsText(deps, args.Numbers), false)
	case "add_review_comment":
		if deps.AddComment == nil {
			return textResult("add_review_comment is not available in this session.", true)
		}
		var args struct {
			Path    string `json:"path"`
			Line    int    `json:"line"`
			ReplyTo int    `json:"reply_to"`
			Body    string `json:"body"`
		}
		_ = json.Unmarshal(p.Arguments, &args)
		if strings.TrimSpace(args.Body) == "" {
			return textResult("add_review_comment needs a non-empty \"body\".", true)
		}
		msg, ok := deps.AddComment(strings.TrimSpace(args.Path), args.Line, args.ReplyTo, args.Body)
		return textResult(msg, !ok)
	case "reply_to_review_comment":
		if deps.ReplyLocal == nil {
			return textResult("reply_to_review_comment is not available in this session.", true)
		}
		var args struct {
			Number int    `json:"number"`
			Body   string `json:"body"`
		}
		_ = json.Unmarshal(p.Arguments, &args)
		if args.Number <= 0 || strings.TrimSpace(args.Body) == "" {
			return textResult("reply_to_review_comment needs a \"number\" (from get_review_comments) and a non-empty \"body\".", true)
		}
		ok, msg := deps.ReplyLocal(args.Number, args.Body)
		if msg == "" && ok {
			msg = "Saved. The user can see it in Hydra next to the comment it answers; it was NOT posted to the forge."
		}
		return textResult(msg, !ok)
	case "resolve_review_comments":
		if deps.ResolveComments == nil {
			return textResult("resolve_review_comments is not available in this session.", true)
		}
		var args struct {
			Numbers []int `json:"numbers"`
			Reopen  bool  `json:"reopen"`
		}
		_ = json.Unmarshal(p.Arguments, &args)
		if len(args.Numbers) == 0 {
			return textResult("resolve_review_comments needs \"numbers\" - the comments you are done with, from get_review_comments.", true)
		}
		msg, ok := deps.ResolveComments(args.Numbers, args.Reopen)
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
// The Hydra-native comments come first and the forge discussions after, under
// their own headings: an agent reading top-down should meet the feedback that
// exists whether or not this head was ever published.
func reviewCommentsText(deps Deps, numbers []int) string {
	var hydra string
	if deps.HydraComments != nil {
		// The ok flag is deliberately ignored: its only failure is "no comment has
		// that number", which is worth telling the agent verbatim but must not
		// swallow the forge half of the answer.
		hydra, _ = deps.HydraComments(numbers)
	}
	forge := forgeCommentsText(deps)
	switch {
	case hydra == "":
		return forge
	case forge == "" || forge == unlinkedText:
		// No MR: the Hydra comments ARE the review, so do not pad the answer with an
		// explanation of a forge this head has nothing to do with.
		return hydra
	default:
		return "Review comments left in Hydra:\n\n" + hydra + "\n\n---\n\n" + forge
	}
}

// forgeCommentsText renders the unresolved discussions on this head's MR.
func forgeCommentsText(deps Deps) string {
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
		if c.Number > 0 {
			b.WriteString("[#" + itoa(c.Number) + "]")
		} else if c.ID != "" {
			b.WriteString("[thread " + c.ID + "]")
		}
		b.WriteString("\n   ")
		b.WriteString(strings.ReplaceAll(strings.TrimSpace(c.Body), "\n", "\n   "))
		b.WriteString("\n")
	}
	if deps.ReplyLocal != nil {
		b.WriteString("\nUse reply_to_review_comment with a comment's number to answer one of these for the USER to read in Hydra (local only - it is not posted to the forge).\n")
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
