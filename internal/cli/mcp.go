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
	"github.com/trolleyman/hydra/internal/commitq"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/git"
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
		Commit:        commitHeadChanges,
	}
	// Wire the review tools only when this head has a review file (HYDRA_REVIEW_PATH
	// is seeded for every head; the file reports linked=false until published).
	if os.Getenv("HYDRA_REVIEW_PATH") != "" {
		deps.GetReview = loadReviewFile
	}
	return errtrace.Wrap(mcpserver.Run(deps, stdin, stdout))
}

// commitPollInterval / commitTimeout bound the in-sandbox wait for a
// host-mediated commit result (the watcher runs on a ~1s cadence).
const (
	commitPollInterval = 200 * time.Millisecond
	commitTimeout      = 30 * time.Second
)

// commitHeadChanges backs the git_commit MCP tool. It commits the head's changes
// onto its own branch inside its worktree, using the head-context env
// (HYDRA_WORKTREE / HYDRA_BRANCH). When HYDRA_COMMIT_DIR is set (git_isolation
// refs/readonly, where .git is read-only in the sandbox), it hands the commit to
// the host daemon over the commitq file channel instead of running git itself.
func commitHeadChanges(req mcpserver.CommitRequest) mcpserver.CommitResult {
	if dir := os.Getenv("HYDRA_COMMIT_DIR"); dir != "" {
		return commitViaDaemon(dir, req)
	}
	return gitCommit(os.Getenv("HYDRA_WORKTREE"), os.Getenv("HYDRA_BRANCH"), req)
}

// gitCommit commits in-sandbox via the shared guardrail (git_isolation off).
func gitCommit(worktree, branch string, req mcpserver.CommitRequest) mcpserver.CommitResult {
	ok, msg := git.GuardedCommit(worktree, branch, req.Message, req.Paths, req.Amend)
	return mcpserver.CommitResult{OK: ok, Message: msg}
}

// commitViaDaemon submits the commit to the daemon's commit watcher and blocks
// for the result (the sandbox can't write refs, and can't reach the daemon
// socket, so it uses the writable commitq dir + polling - like gate approvals).
func commitViaDaemon(dir string, req mcpserver.CommitRequest) mcpserver.CommitResult {
	reqid := strconv.FormatInt(time.Now().UnixNano(), 10)
	if err := commitq.WriteRequest(dir, commitq.Request{
		ReqID: reqid, Message: req.Message, Paths: req.Paths, Amend: req.Amend,
		TS: time.Now().Format(time.RFC3339Nano),
	}); err != nil {
		return mcpserver.CommitResult{Message: "Failed to submit the commit to Hydra: " + err.Error()}
	}
	deadline := time.Now().Add(commitTimeout)
	for {
		if res, ok, err := commitq.ReadResult(dir, reqid); err == nil && ok {
			return mcpserver.CommitResult{OK: res.OK, Message: res.Message}
		}
		if time.Now().After(deadline) {
			return mcpserver.CommitResult{Message: "Timed out waiting for Hydra to perform the commit. Ask the user to check the daemon."}
		}
		time.Sleep(commitPollInterval)
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
