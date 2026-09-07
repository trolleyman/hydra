package agenthost

import (
	"fmt"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/gitq"
	"github.com/trolleyman/hydra/internal/policyapi"
)

func watchGitOperations(dir, workspace string, policy policyapi.GitPolicy, approvals *approvalBroker) func() {
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				requests, err := gitq.ListRequests(dir)
				if err != nil {
					continue
				}
				for _, request := range requests {
					handleGitOperation(dir, workspace, policy, approvals, request, stop)
				}
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(stop) }) }
}

func handleGitOperation(dir, workspace string, policy policyapi.GitPolicy, approvals *approvalBroker, request gitq.Request, cancel <-chan struct{}) {
	operation := string(request.Op)
	if operation == "" {
		operation = "commit"
	}
	decision := policy.Operations[operation]
	if decision == "" {
		decision = policyapi.PolicyDeny
	}
	if decision == policyapi.PolicyDeny {
		_ = gitq.WriteResult(dir, request.ReqID, gitq.Result{Message: "git_" + operation + " is disabled by the active profile."})
		return
	}
	branch, branchErr := git.GetCurrentBranch(workspace)
	head, headErr := git.ResolveRef(workspace, "HEAD")
	if branchErr != nil || headErr != nil || request.ExpectedBranch == "" || request.ExpectedHead == "" || branch != request.ExpectedBranch || head != request.ExpectedHead {
		_ = gitq.WriteResult(dir, request.ReqID, gitq.Result{Message: "Refusing Git operation: the workspace branch or HEAD changed after the request was created."})
		return
	}
	if operation != "checkout" {
		for _, pattern := range protectedBranches(policy) {
			if matched, _ := path.Match(pattern, branch); matched || pattern == branch {
				_ = gitq.WriteResult(dir, request.ReqID, gitq.Result{Message: fmt.Sprintf("Refusing git_%s on protected branch %q.", operation, branch)})
				return
			}
		}
	}
	if decision == policyapi.PolicyAsk && !approvals.requestGit(operation, branch, cancel) {
		_ = gitq.WriteResult(dir, request.ReqID, gitq.Result{Message: "The user denied git_" + operation + "."})
		return
	}
	ok, message := git.RunGuardedOp(workspace, branch, request)
	_ = gitq.WriteResult(dir, request.ReqID, gitq.Result{OK: ok, Message: message})
}

func protectedBranches(policy policyapi.GitPolicy) []string {
	if policy.ProtectedBranches == nil {
		return nil
	}
	return *policy.ProtectedBranches
}

func enabledGitOperations(policy policyapi.GitPolicy) []string {
	operations := make([]string, 0, len(policy.Operations))
	for operation, decision := range policy.Operations {
		if decision != policyapi.PolicyDeny && strings.TrimSpace(operation) != "" {
			operations = append(operations, operation)
		}
	}
	sort.Strings(operations)
	return operations
}

var validGitOperations = map[string]bool{
	"checkout": true, "commit": true, "add": true, "reset": true,
	"revert": true, "cherry_pick": true,
	"merge": true, "merge_continue": true, "merge_abort": true,
	"rebase": true, "rebase_continue": true, "rebase_abort": true,
	"stash": true,
}
