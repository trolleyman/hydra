// Package agent manages the lifecycle of AI coding agents running in Docker sandboxes.
package agent

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/trolleyman/hydra/internal/db"
)

// Manager handles agent creation, monitoring, and teardown.
type Manager struct {
	db           *sql.DB
	worktreesDir string
}

// NewManager creates a new agent Manager.
func NewManager(sqlDB *sql.DB, worktreesDir string) *Manager {
	return &Manager{db: sqlDB, worktreesDir: worktreesDir}
}

// AIProviderToSandboxType maps an AI provider to its Docker sandbox type.
func AIProviderToSandboxType(aiProvider string) string {
	switch aiProvider {
	case "claude":
		return "claude-code"
	case "gemini":
		return "gemini"
	case "codex":
		return "codex"
	case "copilot":
		return "copilot"
	case "cagent":
		return "cagent"
	case "kiro":
		return "kiro"
	case "opencode":
		return "opencode"
	default:
		return "shell"
	}
}

// DefaultSandboxTemplate returns the default sandbox template image for an AI provider.
func DefaultSandboxTemplate(aiProvider string) string {
	switch aiProvider {
	case "claude":
		return "docker/sandbox-templates:claude-code"
	case "gemini":
		return "docker/sandbox-templates:gemini"
	default:
		return ""
	}
}

// Start launches the Docker sandbox for an agent asynchronously.
// It creates the git worktree, launches the sandbox, and updates the DB.
func (m *Manager) Start(ctx context.Context, agent db.Agent, projectPath string) {
	go m.run(context.Background(), agent, projectPath)
}

func (m *Manager) run(ctx context.Context, agent db.Agent, projectPath string) {
	// 1. Create git worktree
	if err := createWorktree(projectPath, agent.WorktreePath, agent.Branch); err != nil {
		log.Printf("agent %s: create worktree: %v", agent.ID, err)
		db.UpdateAgentStatus(m.db, agent.ID, "failed")
		return
	}

	// 2. Create and start Docker sandbox
	sandboxID := agent.ID
	sandboxType := AIProviderToSandboxType(agent.AIProvider)

	template := ""
	if agent.SandboxTemplate != nil {
		template = *agent.SandboxTemplate
	} else {
		template = DefaultSandboxTemplate(agent.AIProvider)
	}

	db.UpdateAgentStatus(m.db, agent.ID, "starting")

	if err := createSandbox(ctx, sandboxID, sandboxType, template, agent.WorktreePath, agent.Prompt); err != nil {
		log.Printf("agent %s: create sandbox: %v", agent.ID, err)
		db.UpdateAgentStatus(m.db, agent.ID, "failed")
		return
	}

	db.UpdateAgentSandboxID(m.db, agent.ID, sandboxID)
	db.UpdateAgentStatus(m.db, agent.ID, "running")

	// 3. Poll for completion and collect logs
	m.pollAndCollectLogs(ctx, agent.ID, sandboxID)
}

func createWorktree(projectPath, worktreePath, branch string) error {
	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(worktreePath), 0755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}

	// Check if branch already exists
	checkCmd := exec.Command("git", "-C", projectPath, "rev-parse", "--verify", branch)
	branchExists := checkCmd.Run() == nil

	var cmd *exec.Cmd
	if branchExists {
		cmd = exec.Command("git", "-C", projectPath, "worktree", "add", worktreePath, branch)
	} else {
		cmd = exec.Command("git", "-C", projectPath, "worktree", "add", "-b", branch, worktreePath)
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git worktree add: %w: %s", err, out)
	}
	return nil
}

func createSandbox(ctx context.Context, sandboxID, sandboxType, template, worktreePath, prompt string) error {
	args := []string{"sandbox", "create", "--name", sandboxID}
	if template != "" {
		args = append(args, "-t", template)
	}
	args = append(args, sandboxType)

	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Env = append(os.Environ(),
		"HYDRA_SANDBOX_ID="+sandboxID,
		"HYDRA_PROMPT="+prompt,
		"HYDRA_WORKTREE="+worktreePath,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker sandbox create: %w: %s", err, out)
	}

	// Start the sandbox - mount the worktree
	startArgs := []string{"sandbox", "start",
		"--mount", worktreePath + ":/workspace",
		sandboxID,
	}
	startCmd := exec.CommandContext(ctx, "docker", startArgs...)
	startOut, err := startCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker sandbox start: %w: %s", err, startOut)
	}

	return nil
}

func (m *Manager) pollAndCollectLogs(ctx context.Context, agentID, sandboxID string) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Check sandbox status
			statusOut, err := exec.CommandContext(ctx, "docker", "sandbox", "inspect", sandboxID).CombinedOutput()
			if err != nil {
				log.Printf("agent %s: inspect sandbox: %v", agentID, err)
				// Container may have stopped
				m.handleSandboxExit(ctx, agentID, sandboxID, false)
				return
			}

			// Collect logs
			logsOut, err := exec.CommandContext(ctx, "docker", "sandbox", "logs", "--tail", "100", sandboxID).CombinedOutput()
			if err == nil && len(logsOut) > 0 {
				db.AppendAgentLog(m.db, agentID, string(logsOut))
			}

			// Check if sandbox has exited (simple heuristic: look for "exited" or "stopped")
			statusStr := strings.ToLower(string(statusOut))
			if strings.Contains(statusStr, "exited") || strings.Contains(statusStr, "stopped") {
				success := strings.Contains(statusStr, "exited 0") || strings.Contains(statusStr, "exit code 0")
				m.handleSandboxExit(ctx, agentID, sandboxID, success)
				return
			}
		}
	}
}

func (m *Manager) handleSandboxExit(ctx context.Context, agentID, sandboxID string, success bool) {
	db.UpdateAgentStatus(m.db, agentID, "committing")

	// Auto-commit any remaining changes
	agent, err := db.GetAgentByID(m.db, agentID)
	if err != nil {
		log.Printf("agent %s: get agent for commit: %v", agentID, err)
	} else {
		autoCommit(agent.WorktreePath)
	}

	if success {
		db.UpdateAgentStatus(m.db, agentID, "done")
	} else {
		db.UpdateAgentStatus(m.db, agentID, "failed")
	}
}

func autoCommit(worktreePath string) {
	// Stage all changes
	addCmd := exec.Command("git", "-C", worktreePath, "add", "-A")
	if out, err := addCmd.CombinedOutput(); err != nil {
		log.Printf("git add: %v: %s", err, out)
		return
	}

	// Check if there's anything to commit
	statusCmd := exec.Command("git", "-C", worktreePath, "status", "--porcelain")
	statusOut, _ := statusCmd.Output()
	if len(bytes.TrimSpace(statusOut)) == 0 {
		return // nothing to commit
	}

	commitCmd := exec.Command("git", "-C", worktreePath, "commit", "-m", "chore: auto-commit agent changes")
	if out, err := commitCmd.CombinedOutput(); err != nil {
		log.Printf("git commit: %v: %s", err, out)
	}
}

// Stop stops and removes a sandbox.
func Stop(ctx context.Context, sandboxID string) error {
	cmd := exec.CommandContext(ctx, "docker", "sandbox", "rm", "-f", sandboxID)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker sandbox rm: %w: %s", err, out)
	}
	return nil
}

// RemoveWorktree removes a git worktree and deletes the branch.
func RemoveWorktree(ctx context.Context, projectPath, worktreePath, branch string) error {
	// Remove worktree
	rmCmd := exec.CommandContext(ctx, "git", "-C", projectPath, "worktree", "remove", "--force", worktreePath)
	if out, err := rmCmd.CombinedOutput(); err != nil {
		// Non-fatal: worktree might already be gone
		log.Printf("git worktree remove: %v: %s", err, out)
	}

	// Delete the branch
	branchCmd := exec.CommandContext(ctx, "git", "-C", projectPath, "branch", "-D", branch)
	if out, err := branchCmd.CombinedOutput(); err != nil {
		log.Printf("git branch -D: %v: %s", err, out)
	}

	return nil
}

// MergeWorktree merges a branch into the current branch of the project.
func MergeWorktree(ctx context.Context, projectPath, branch string) error {
	cmd := exec.CommandContext(ctx, "git", "-C", projectPath, "merge", "--no-ff", branch,
		"-m", fmt.Sprintf("Merge agent branch %s", branch))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git merge: %w: %s", err, out)
	}
	return nil
}

// GetDefaultBranch returns the default branch name for a repository.
func GetDefaultBranch(projectPath string) string {
	cmd := exec.Command("git", "-C", projectPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
	out, err := cmd.Output()
	if err == nil {
		branch := strings.TrimPrefix(strings.TrimSpace(string(out)), "origin/")
		if branch != "" {
			return branch
		}
	}
	// Fall back to main, then master
	for _, b := range []string{"main", "master"} {
		check := exec.Command("git", "-C", projectPath, "rev-parse", "--verify", b)
		if check.Run() == nil {
			return b
		}
	}
	return "main"
}

// LogStream returns a channel that receives log lines from a sandbox.
// The channel is closed when the sandbox exits or ctx is cancelled.
func LogStream(ctx context.Context, sandboxID string) <-chan string {
	ch := make(chan string, 100)
	go func() {
		defer close(ch)
		cmd := exec.CommandContext(ctx, "docker", "sandbox", "logs", "--follow", sandboxID)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return
		}
		cmd.Stderr = cmd.Stdout
		if err := cmd.Start(); err != nil {
			return
		}
		buf := make([]byte, 4096)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				select {
				case ch <- string(buf[:n]):
				case <-ctx.Done():
					cmd.Process.Kill()
					return
				}
			}
			if err != nil {
				break
			}
		}
		cmd.Wait()
	}()
	return ch
}
