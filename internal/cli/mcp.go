package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/gitq"
	"github.com/trolleyman/hydra/internal/mcpserver"
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
	// Wire the review tools only when this head has a review file (HYDRA_REVIEW_PATH
	// is seeded for every head; the file reports linked=false until published).
	if os.Getenv("HYDRA_REVIEW_PATH") != "" {
		deps.GetReview = loadReviewFile
	}
	return errtrace.Wrap(mcpserver.Run(deps, stdin, stdout))
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
		Base:   req.Base, Plan: plan,
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

// loadReviewFile reads the per-head review snapshot the MR watcher writes. A
// missing/unreadable file yields nil (the review tools then report "not linked").
func loadReviewFile() *mcpserver.ReviewFile {
	path := os.Getenv("HYDRA_REVIEW_PATH")
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var rf mcpserver.ReviewFile
	if err := json.Unmarshal(data, &rf); err != nil {
		return nil
	}
	return &rf
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
		return false, fmt.Sprintf("%q is not a host-configured MCP server. Call list_available_mcp_servers to see what you can request.", name)
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
