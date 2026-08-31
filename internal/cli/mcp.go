package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/agentq"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/gitq"
	"github.com/trolleyman/hydra/internal/mcpserver"
	"github.com/trolleyman/hydra/internal/reviewq"
)

func init() {
	rootCmd.AddCommand(mcpCmd)
}

// mcpCmd is an internal command seeded into the agent's own MCP config as the
// always-available "hydra" server. It exposes list_available_mcp_servers and
// request_mcp_server (discover/request host-configured MCP servers, gated by the
// same approval round-trip the security gate uses), git_commit (the sanctioned
// commit path onto the head's own branch, since raw `git commit` is gate-denied),
// and, when the head is published, the review tools. It speaks MCP over stdio;
// stdout is the JSON-RPC channel, so all diagnostics go to stderr.
var mcpCmd = &cobra.Command{
	Use:    "mcp <agentType>",
	Short:  "Internal: Hydra control MCP server (discover/request MCP servers)",
	Long:   `Internal MCP server exposing Hydra control tools to the agent. Not intended for direct use.`,
	Hidden: true,
	Args:   cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		if err := runMCPServer(args[0], os.Stdin, os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "hydra mcp error: %v\n", err)
		}
		return nil
	},
}

func runMCPServer(agentType string, stdin io.Reader, stdout io.Writer) error {
	deps := mcpserver.Deps{
		ListAvailable: availableMCPServers,
		RequestAccess: func(name string) (bool, string) { return requestMCPAccess(agentType, name) },
		GitOp:         gitOpFromMCP,
	}
	// The escape hatch needs the gate's approval channel; without one it could only
	// ever fail, so hide it rather than advertise a tool that cannot work.
	if os.Getenv(gate.EnvApprovalDir) != "" {
		deps.HostRun = hostRunFromMCP
	}
	// Wire the review tools only when this head has a review file (HYDRA_REVIEW_PATH
	// is seeded for every head; the file reports linked=false until published).
	if os.Getenv("HYDRA_REVIEW_PATH") != "" {
		deps.GetReview = loadReviewFile
	}
	// The self-status tools ride the same daemon channel: tests/artifacts state
	// lives in the daemon's managers, and services state ONLY ever exists in daemon
	// memory, so there is nothing in the sandbox to read. No channel -> hide them
	// rather than advertise a tool that can only time out.
	// Hydra's own review comments ride the same daemon channel, and - unlike the
	// forge tools above - are NOT gated on a review file: they exist for every
	// head, published or not (docs/review-agent.md).
	if os.Getenv("HYDRA_REVIEW_REQ_DIR") != "" {
		deps.HydraComments = hydraCommentsFromMCP
		deps.AddComment = addReviewCommentFromMCP
		deps.ResolveComments = resolveReviewCommentsFromMCP
		// Replying is no longer gated on a forge link: a number can name one of
		// Hydra's own comments, which exist with or without an MR.
		deps.ReplyLocal = replyLocalToReviewThread
		deps.HeadStatus = headStatusFromMCP
		deps.TestLogs = testLogsFromMCP
		deps.RunTests = func(runner string) (string, bool) { return runFromMCP(reviewq.OpRunTests, runner) }
		deps.RunArtifacts = func(name string) (string, bool) { return runFromMCP(reviewq.OpRunArtifacts, name) }
	}
	if os.Getenv("HYDRA_AGENT_REQ_DIR") != "" {
		deps.ListAgents = listAgentsFromMCP
		deps.GetAgent = getAgentFromMCP
		deps.SendAgent = sendAgentFromMCP
	}
	return errtrace.Wrap(mcpserver.Run(deps, stdin, stdout))
}

func listAgentsFromMCP() (string, bool) {
	return agentRoundTrip(agentq.Request{Op: agentq.OpList})
}

func getAgentFromMCP(id string) (string, bool) {
	return agentRoundTrip(agentq.Request{Op: agentq.OpGet, Target: id})
}

func sendAgentFromMCP(target, body, correlationID, inReplyTo string) (string, bool) {
	return agentRoundTrip(agentq.Request{Op: agentq.OpMessage, Target: target, Body: body, CorrelationID: correlationID, InReplyTo: inReplyTo})
}

func agentRoundTrip(req agentq.Request) (string, bool) {
	dir := os.Getenv("HYDRA_AGENT_REQ_DIR")
	if dir == "" {
		return "Hydra agent collaboration is not available in this session.", false
	}
	req.ReqID = strconv.FormatInt(time.Now().UnixNano(), 10)
	req.TS = time.Now().Format(time.RFC3339Nano)
	if err := agentq.WriteRequest(dir, req); err != nil {
		return "Hydra could not be reached (" + err.Error() + ").", false
	}
	deadline := time.Now().Add(reviewRefreshWait)
	for {
		if res, ok, err := agentq.ReadResult(dir, req.ReqID); err == nil && ok {
			return res.Message, res.OK
		}
		if time.Now().After(deadline) {
			return "Hydra did not answer the agent request in time. Do not repeat a message blindly; ask the user to check the daemon.", false
		}
		time.Sleep(reviewRefreshPoll)
	}
}

// hostRunFromMCP backs the host_run MCP tool: it parks the approval and blocks
// for the outcome exactly as `hydra host-run` does (both go through
// requestHostRun), then renders the result as tool output instead of relaying it
// to stdout and an exit code.
//
// The command is taken verbatim from the tool argument - no shell of the agent's
// stands between it and the approval card - which is the whole reason this tool
// exists alongside the CLI.
func hostRunFromMCP(req mcpserver.HostRunRequest) mcpserver.HostRunResult {
	return renderHostRunOutcome(requestHostRun(req.Command, req.Why))
}

// renderHostRunOutcome turns a host-run outcome into the tool's result. Split
// out from the request itself so the wording - which is the agent's only account
// of what happened - is testable without an approval channel.
func renderHostRunOutcome(outcome hostRunOutcome) mcpserver.HostRunResult {
	// Every one of these is "nothing ran", but WHY decides what the agent should
	// do next, so each says so in its own words rather than sharing one blanket
	// failure line. A denial in particular has to be unmistakable: it is the
	// user's answer, not a glitch to route around by asking again.
	switch outcome.Refusal {
	case hostRunDenied:
		return mcpserver.HostRunResult{Failed: true, Message: "DENIED by the user. The command did NOT run and nothing on the host was changed. This is their decision - do not re-request the same command, and do not look for another way to do it outside the sandbox. If you are stuck, say what you needed and why, and ask them how to proceed."}
	case hostRunNoDecision:
		return mcpserver.HostRunResult{Failed: true, Message: "TIMED OUT waiting for the user to answer, so the request was withdrawn. The command did NOT run and nothing on the host was changed. The user may simply have been away - if this is still needed, say so in your reply rather than silently asking again."}
	case hostRunNoChannel:
		return mcpserver.HostRunResult{Failed: true, Message: "UNAVAILABLE: this session has no approval channel, so a host command cannot be requested at all. The command did NOT run. Nothing you can do will change that - tell the user what you needed."}
	case hostRunNoResult:
		return mcpserver.HostRunResult{Failed: true, Message: "The user ALLOWED the command, but it did not return in time, so its outcome is unknown. It may still be running on the host, and it may have changed things. Do not re-run it blindly - check the state first, and tell the user."}
	case hostRunSubmitFail:
		return mcpserver.HostRunResult{Failed: true, Message: "The request could not be submitted to Hydra, so the user never saw it and the command did NOT run: " + outcome.Detail}
	}
	r := outcome.Result
	if r.Error != "" {
		return mcpserver.HostRunResult{Failed: true, Message: "The user allowed the command, but the host could not run it: " + r.Error}
	}
	var b strings.Builder
	switch {
	case r.TimedOut:
		b.WriteString("FAILED on the host: killed at the execution timeout, so it has no exit status. Anything it had already done still happened.\n")
	case r.ExitCode == 0:
		b.WriteString("Ran on the host; exit status 0.\n")
	default:
		fmt.Fprintf(&b, "FAILED on the host: exit status %d.\n", r.ExitCode)
	}
	if r.Truncated {
		b.WriteString("(output truncated to its final portion)\n")
	}
	if strings.TrimSpace(r.Output) == "" {
		b.WriteString("\n(no output)")
	} else {
		b.WriteString("\n" + r.Output)
	}
	// A non-zero exit is a failed tool call, matching the Bash tool - a command
	// on the host is still a command, and the agent should not have to parse the
	// status line out of the output to notice it failed. The chat marks the card
	// failed on the same signal, so the two read alike.
	return mcpserver.HostRunResult{Failed: r.TimedOut || r.ExitCode != 0, Message: b.String()}
}

// gitOpPollInterval / gitOpTimeout bound the in-sandbox wait for a host-mediated
// git-op result (the watcher runs on a ~1s cadence). Rebase/cherry-pick can run a
// little long, so the timeout is generous.
const (
	gitOpPollInterval = 200 * time.Millisecond
	gitOpTimeout      = 60 * time.Second
)

// gitOpFromMCP backs the git_* MCP tools. It translates the tool's GitOpRequest
// into a gitq.Request and runs it on the head's own branch, using the
// head-context env (HYDRA_WORKTREE / HYDRA_BRANCH). When HYDRA_GITOPS_DIR is set
// (git_isolation readonly, where .git is read-only in the sandbox), it hands the
// op to the host daemon over the gitq file channel instead of running git itself.
func gitOpFromMCP(req mcpserver.GitOpRequest) mcpserver.GitOpResult {
	add := make([]gitq.AddSpec, len(req.Add))
	for i, a := range req.Add {
		add[i] = gitq.AddSpec{Path: a.Path, Ranges: a.Ranges}
	}
	plan := make([]gitq.RebaseStep, len(req.Plan))
	for i, s := range req.Plan {
		plan[i] = gitq.RebaseStep{Commit: s.Commit, Action: s.Action, Message: s.Message}
	}
	res := runGitOp(gitq.Request{
		Op:      gitq.Op(req.Op),
		Message: req.Message, Paths: req.Paths, Amend: req.Amend, Staged: req.Staged,
		Mode: req.Mode, To: req.To, Unstage: req.Unstage, Confirm: req.Confirm,
		Add:    add,
		Commit: req.Commit,
		Base:   req.Base, Onto: req.Onto, Plan: plan,
		Ref: req.Ref, NoFF: req.NoFF,
		Stash: req.Stash, StashRef: req.StashRef, IncludeUntracked: req.IncludeUntracked,
	})
	return mcpserver.GitOpResult{OK: res.OK, Message: res.Message}
}

// runGitOp performs a git write-op on the head's own branch: in-sandbox via the
// shared own-branch guard (git_isolation off), or host-mediated over the gitq
// channel when HYDRA_GITOPS_DIR is set (readonly, where .git is read-only in the
// sandbox and the daemon socket is unreachable - so it writes a request and polls
// for the result, like the gate approval channel).
func runGitOp(req gitq.Request) gitq.Result {
	if dir := os.Getenv("HYDRA_GITOPS_DIR"); dir != "" {
		return gitOpViaDaemon(dir, req)
	}
	ok, msg := git.RunGuardedOp(os.Getenv("HYDRA_WORKTREE"), os.Getenv("HYDRA_BRANCH"), req)
	return gitq.Result{OK: ok, Message: msg}
}

// gitOpViaDaemon submits req to the daemon's gitops watcher and blocks for the
// result over the writable gitq dir + polling.
func gitOpViaDaemon(dir string, req gitq.Request) gitq.Result {
	// A branchless project-directory head sets HYDRA_BRANCH empty and works in the real
	// project checkout. Capture both identities at request time so the daemon can
	// refuse a commit if the user changes branch or advances HEAD in the gap.
	if os.Getenv("HYDRA_BRANCH") == "" {
		workdir := os.Getenv("HYDRA_WORKTREE")
		if branch, err := git.GetCurrentBranch(workdir); err == nil {
			req.ExpectedBranch = branch
		}
		if head, err := git.ResolveRef(workdir, "HEAD"); err == nil {
			req.ExpectedHead = head
		}
	}
	req.ReqID = strconv.FormatInt(time.Now().UnixNano(), 10)
	req.TS = time.Now().Format(time.RFC3339Nano)
	if err := gitq.WriteRequest(dir, req); err != nil {
		return gitq.Result{Message: "Failed to submit the git operation to Hydra: " + err.Error()}
	}
	deadline := time.Now().Add(gitOpTimeout)
	for {
		if res, ok, err := gitq.ReadResult(dir, req.ReqID); err == nil && ok {
			return res
		}
		if time.Now().After(deadline) {
			return gitq.Result{Message: "Timed out waiting for Hydra to perform the git operation. Ask the user to check the daemon."}
		}
		time.Sleep(gitOpPollInterval)
	}
}

// reviewRefreshPoll / reviewRefreshWait bound the in-sandbox wait for the daemon
// to re-read the MR from the forge. The wait is a little longer than the host's
// own forge timeout (reviewRefreshTimeout), so a slow-but-succeeding refresh is
// used rather than raced past.
const (
	reviewRefreshPoll = 200 * time.Millisecond
	reviewRefreshWait = 25 * time.Second
)

// loadReviewFile returns this head's review snapshot for the review tools. It
// first asks the daemon to re-read the MR from the forge (the sandbox has no
// forge credentials and, under hard egress, no route to the forge - so every
// forge call is host-side), then reads the file the daemon rewrote. A refresh
// that fails or times out is not fatal: the last cached snapshot is returned with
// the reason attached, which beats answering "no comments" from stale state. A
// missing/unreadable file yields nil (the review tools then report "not linked").
func loadReviewFile() *mcpserver.ReviewFile {
	path := os.Getenv("HYDRA_REVIEW_PATH")
	if path == "" {
		return nil
	}
	staleReason := requestReviewRefresh()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var rf mcpserver.ReviewFile
	if err := json.Unmarshal(data, &rf); err != nil {
		return nil
	}
	rf.StaleReason = staleReason
	return &rf
}

// requestReviewRefresh asks the daemon (over the reviewq file channel) to refresh
// this head's review file and blocks for the verdict. It returns "" when the
// snapshot can be trusted as current, else why it can't.
func requestReviewRefresh() string {
	dir := os.Getenv("HYDRA_REVIEW_REQ_DIR")
	if dir == "" {
		return "" // older head (seeded before the refresh channel existed) - the 30s watcher is the only writer
	}
	res, ok := reviewRoundTrip(dir, reviewq.Request{Op: reviewq.OpRefresh})
	if !ok {
		return "Hydra did not answer the refresh in time, so this is its last cached state. Ask the user to check the daemon if it keeps happening."
	}
	return res.Message
}

// replyLocalToReviewThread backs the reply_to_review_comment tool: it hands the
// note to the daemon, which stores it against the thread for the user to read in
// the diff viewer. Nothing is sent to the forge.
func replyLocalToReviewThread(number int, body string) (bool, string) {
	dir := os.Getenv("HYDRA_REVIEW_REQ_DIR")
	if dir == "" {
		return false, "Replying is not available in this session."
	}
	res, ok := reviewRoundTrip(dir, reviewq.Request{Op: reviewq.OpNote, ReplyTo: number, Body: body})
	if !ok {
		return false, "Hydra did not confirm the note in time, so it may not have been saved. Ask the user to check the daemon."
	}
	return res.OK, res.Message
}

// hydraCommentsFromMCP backs the Hydra half of get_review_comments. The store is
// host-side (the sandbox has no view of it), so this is a round trip like every
// other daemon-answered tool.
func hydraCommentsFromMCP(numbers []int) (string, bool) {
	dir := os.Getenv("HYDRA_REVIEW_REQ_DIR")
	if dir == "" {
		return "", false
	}
	res, ok := reviewRoundTrip(dir, reviewq.Request{Op: reviewq.OpComments, Numbers: numbers})
	if !ok {
		return "Hydra did not answer in time, so its review comments could not be read.", false
	}
	return res.Message, res.OK
}

// addReviewCommentFromMCP backs add_review_comment.
func addReviewCommentFromMCP(path string, line, replyTo int, body string, attachments []string) (string, bool) {
	dir := os.Getenv("HYDRA_REVIEW_REQ_DIR")
	if dir == "" {
		return "Leaving review comments is not available in this session.", false
	}
	// The paths go over as the agent wrote them; the daemon does the resolving and
	// the copying, because only it can see outside the sandbox.
	res, ok := reviewRoundTrip(dir, reviewq.Request{
		Op: reviewq.OpAddComment, Path: path, Line: line, ReplyTo: replyTo, Body: body,
		Attachments: attachments,
	})
	if !ok {
		return "Hydra did not confirm the comment in time, so it may not have been saved. Ask the user to check the daemon.", false
	}
	return res.Message, res.OK
}

// resolveReviewCommentsFromMCP backs resolve_review_comments. Like every other
// write to the comment store, the store is host-side, so this is a round trip.
func resolveReviewCommentsFromMCP(numbers []int, reopen bool) (string, bool) {
	dir := os.Getenv("HYDRA_REVIEW_REQ_DIR")
	if dir == "" {
		return "Resolving review comments is not available in this session.", false
	}
	res, ok := reviewRoundTrip(dir, reviewq.Request{Op: reviewq.OpResolveComment, Numbers: numbers, Reopen: reopen})
	if !ok {
		return "Hydra did not confirm in time, so those comments may still be open. Check with get_review_comments.", false
	}
	return res.Message, res.OK
}

// headStatusFromMCP backs get_head_status: it asks the daemon for this head's
// tests/artifacts/services summary and relays the text it rendered. The daemon
// does the rendering because it owns the state - the sandbox has no view of the
// test cache or the service supervisors at all.
func headStatusFromMCP() (string, bool) {
	dir := os.Getenv("HYDRA_REVIEW_REQ_DIR")
	if dir == "" {
		return "Status is not available in this session.", false
	}
	res, ok := reviewRoundTrip(dir, reviewq.Request{Op: reviewq.OpHeadStatus})
	if !ok {
		return "Hydra did not answer in time, so your status could not be read. Ask the user to check the daemon if it keeps happening.", false
	}
	return res.Message, res.OK
}

// testLogsFromMCP backs get_test_logs. tail is passed through as-is; the daemon
// applies the default and the cap, so the bound lives in one place next to the
// log it bounds.
func testLogsFromMCP(runner string, tail int) (string, bool) {
	dir := os.Getenv("HYDRA_REVIEW_REQ_DIR")
	if dir == "" {
		return "Test logs are not available in this session.", false
	}
	res, ok := reviewRoundTrip(dir, reviewq.Request{Op: reviewq.OpTestLogs, Runner: runner, Tail: tail})
	if !ok {
		return "Hydra did not answer in time, so the test log could not be read. Ask the user to check the daemon if it keeps happening.", false
	}
	return res.Message, res.OK
}

// runFromMCP backs retry_tests / retry_artifacts: it asks the daemon to discard
// the cached result for this head's branch tip and start a fresh run. The daemon
// returns as soon as the work is queued - it never waits for a suite to finish -
// so this round trip stays as short as any other, and the agent learns the
// outcome from get_head_status.
func runFromMCP(op reviewq.Op, target string) (string, bool) {
	dir := os.Getenv("HYDRA_REVIEW_REQ_DIR")
	if dir == "" {
		return "Starting a run is not available in this session.", false
	}
	res, ok := reviewRoundTrip(dir, reviewq.Request{Op: op, Runner: target})
	if !ok {
		// Ambiguous on purpose: the request may well have been picked up, so the
		// agent must check rather than fire it again.
		return "Hydra did not confirm in time, so the run may or may not have started. Call mcp__hydra__get_head_status to see, rather than asking again.", false
	}
	return res.Message, res.OK
}

// reviewRoundTrip submits req to the daemon's review-request watcher and blocks
// for its result. ok=false means the wait timed out.
func reviewRoundTrip(dir string, req reviewq.Request) (reviewq.Result, bool) {
	req.ReqID = strconv.FormatInt(time.Now().UnixNano(), 10)
	req.TS = time.Now().Format(time.RFC3339Nano)
	if err := reviewq.WriteRequest(dir, req); err != nil {
		return reviewq.Result{Message: "Hydra could not be reached (" + err.Error() + ")."}, true
	}
	deadline := time.Now().Add(reviewRefreshWait)
	for {
		if res, ok, err := reviewq.ReadResult(dir, req.ReqID); err == nil && ok {
			return res, true
		}
		if time.Now().After(deadline) {
			return reviewq.Result{}, false
		}
		time.Sleep(reviewRefreshPoll)
	}
}

// loadMCPCatalog reads the seeded catalog of host-configured MCP servers. Missing
// or unreadable → empty (best-effort).
func loadMCPCatalog() []mcpserver.Candidate {
	path := os.Getenv(gate.EnvMCPCatalogPath)
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []mcpserver.Candidate
	_ = json.Unmarshal(data, &out)
	return out
}

// availableMCPServers is the catalog minus the servers already on the allow-list
// (whole-server grants) - i.e. the servers the agent could still request.
func availableMCPServers() []mcpserver.Candidate {
	catalog := loadMCPCatalog()
	allowed := map[string]bool{}
	if p, err := gate.LoadPolicy(os.Getenv(gate.EnvPolicyPath)); err == nil {
		for _, s := range p.MCPAllowed {
			allowed[s] = true
		}
	}
	var out []mcpserver.Candidate
	for _, c := range catalog {
		if !allowed[c.Name] {
			out = append(out, c)
		}
	}
	return out
}

// requestMCPAccess parks an approval for MCP server `name` (reusing the gate's
// request/decision file channel, so it surfaces as the normal approval toast) and
// blocks for the verdict. It only permits requesting a server that is actually in
// the host catalog, so the agent can't authorise an arbitrary process.
func requestMCPAccess(agentType, name string) (bool, string) {
	inCatalog := false
	for _, c := range loadMCPCatalog() {
		if c.Name == name {
			inCatalog = true
			break
		}
	}
	if !inCatalog {
		return false, fmt.Sprintf("%q is not a host-configured MCP server. Call mcp__hydra__list_available_mcp_servers to see what you can request.", name)
	}

	dir := os.Getenv(gate.EnvApprovalDir)
	if dir == "" {
		return false, "No approval channel is available, so access can't be requested right now."
	}

	reqid := strconv.FormatInt(time.Now().UnixNano(), 10)
	summary := "wants to enable MCP server " + strconv.Quote(name)
	req := gate.Request{
		ReqID:   reqid,
		Tool:    "hydra__request_mcp_server",
		Kind:    "mcp",
		Target:  name,
		Reason:  "the agent requested access to MCP server " + strconv.Quote(name),
		Summary: summary,
		TS:      time.Now().Format(time.RFC3339Nano),
	}
	if err := gate.WriteRequest(dir, req); err != nil {
		return false, "Failed to submit the access request: " + err.Error()
	}

	deadline := time.Now().Add(askTimeout)
	for {
		// Re-stamp the approval status each iteration so the UI card stays visible
		// (the status hook may overwrite it with a plain "running" between polls).
		writeApprovalStatus(summary)
		if d, ok, err := gate.ReadDecision(dir, reqid); err == nil && ok {
			if d.Decision == gate.Allow {
				return true, fmt.Sprintf("Access to MCP server %q was approved and added to your allow-list. MCP servers load at launch, so it becomes available after your session reloads - ask the user to resume/restart you to use it.", name)
			}
			return false, fmt.Sprintf("Access to MCP server %q was denied.", name)
		}
		if time.Now().After(deadline) {
			return false, fmt.Sprintf("The request for MCP server %q timed out without a decision.", name)
		}
		time.Sleep(askPollInterval)
	}
}
