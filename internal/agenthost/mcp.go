package agenthost

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/gitq"
	"github.com/trolleyman/hydra/internal/mcpserver"
)

const (
	gitPollInterval  = 100 * time.Millisecond
	gitResultTimeout = 5 * time.Minute
)

// RunMCP serves the standalone host's deliberately narrow in-sandbox control
// server. It exposes only profile-enabled Git operations and communicates their
// mutations to the parent host over the private file queue.
func RunMCP(in io.Reader, out io.Writer) error {
	allowed := map[string]bool{}
	for _, operation := range strings.Split(os.Getenv("HYDRA_VSCODE_GIT_OPERATIONS"), ",") {
		if operation = strings.TrimSpace(operation); operation != "" {
			allowed[operation] = true
		}
	}
	return errtrace.Wrap(mcpserver.Run(mcpserver.Deps{
		HideDiscovery: true,
		GitAllowed:    func(operation string) bool { return allowed[operation] },
		GitOp: func(request mcpserver.GitOpRequest) mcpserver.GitOpResult {
			result := submitGitOperation(toGitQueueRequest(request))
			return mcpserver.GitOpResult{OK: result.OK, Message: result.Message}
		},
	}, in, out))
}

func toGitQueueRequest(request mcpserver.GitOpRequest) gitq.Request {
	add := make([]gitq.AddSpec, len(request.Add))
	for i, value := range request.Add {
		add[i] = gitq.AddSpec{Path: value.Path, Ranges: value.Ranges}
	}
	plan := make([]gitq.RebaseStep, len(request.Plan))
	for i, value := range request.Plan {
		plan[i] = gitq.RebaseStep{Commit: value.Commit, Action: value.Action, Message: value.Message}
	}
	return gitq.Request{
		Op: gitq.Op(request.Op), Message: request.Message, Paths: request.Paths, Amend: request.Amend, Staged: request.Staged,
		Mode: request.Mode, To: request.To, Unstage: request.Unstage, Confirm: request.Confirm, Add: add,
		Commit: request.Commit, Base: request.Base, Onto: request.Onto, Plan: plan, Ref: request.Ref, NoFF: request.NoFF,
		Stash: request.Stash, StashRef: request.StashRef, IncludeUntracked: request.IncludeUntracked,
	}
}

func submitGitOperation(request gitq.Request) gitq.Result {
	dir, workspace := os.Getenv("HYDRA_GITOPS_DIR"), os.Getenv("HYDRA_WORKTREE")
	if dir == "" || workspace == "" {
		return gitq.Result{Message: "The Git broker is unavailable in this session."}
	}
	branch, branchErr := git.GetCurrentBranch(workspace)
	head, headErr := git.ResolveRef(workspace, "HEAD")
	if branchErr != nil || headErr != nil {
		return gitq.Result{Message: "Could not snapshot the current Git branch and HEAD."}
	}
	request.ReqID = strconv.FormatInt(time.Now().UnixNano(), 10)
	request.TS, request.ExpectedBranch, request.ExpectedHead = time.Now().Format(time.RFC3339Nano), branch, head
	if err := gitq.WriteRequest(dir, request); err != nil {
		return gitq.Result{Message: "Could not submit Git operation: " + err.Error()}
	}
	deadline := time.Now().Add(gitResultTimeout)
	for time.Now().Before(deadline) {
		if result, ok, err := gitq.ReadResult(dir, request.ReqID); err == nil && ok {
			return result
		}
		time.Sleep(gitPollInterval)
	}
	return gitq.Result{Message: fmt.Sprintf("Timed out waiting for approval of git_%s.", request.Op)}
}
