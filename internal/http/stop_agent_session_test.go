package http

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
	"github.com/trolleyman/hydra/internal/statepath"
)

type stopSessionPTY struct{ *collaborationPTY }

func (p *stopSessionPTY) Signal(os.Signal) error { return errtrace.Wrap(p.Close()) }

func TestStopAgentSessionRetainsHeadAndWorktree(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv("HOME", home)
	t.Setenv(statepath.Environment, filepath.Join(home, "state"))

	root, err := paths.NormalizePath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store, err := db.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	manager, err := projects.NewManager(store)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.AddProject(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { statepath.UnregisterProject(root) })

	const id = "stop-only"
	worktree := paths.GetWorktreeDirFromProjectRoot(root, id)
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateAgent(&db.Agent{
		ID:            id,
		ProjectPath:   root,
		AgentType:     "claude",
		BranchName:    "hydra/stop-only",
		BaseBranch:    "main",
		SessionPID:    4242,
		SessionStatus: "running",
	}); err != nil {
		t.Fatal(err)
	}

	registry := session.NewRegistry()
	pty := &stopSessionPTY{newCollaborationPTY()}
	if _, err := registry.StartWithProc(id, sandbox.AgentTypeClaude, worktree, 24, 80, false, session.KindTerminal, pty); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pty.Close() })
	server := &Server{DB: store, Sessions: registry, ProjectRoot: root, ProjectsManager: manager}

	response, err := server.StopAgentSession(context.Background(), api.StopAgentSessionRequestObject{
		ProjectId: project.ID,
		AgentId:   id,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := response.(api.StopAgentSession204Response); !ok {
		t.Fatalf("response = %T, want StopAgentSession204Response", response)
	}
	if registry.IsLive(id) {
		t.Fatal("agent session is still live")
	}
	if _, err := os.Stat(worktree); err != nil {
		t.Fatalf("worktree was removed: %v", err)
	}
	agent, err := store.GetAgent(id)
	if err != nil {
		t.Fatal(err)
	}
	if agent == nil {
		t.Fatal("agent was archived")
	}
	if agent.BranchName != "hydra/stop-only" {
		t.Fatalf("branch = %q, want retained branch", agent.BranchName)
	}
	if agent.SessionPID != 0 || agent.SessionStatus != "stopped" {
		t.Fatalf("session = pid %d, status %q; want stopped", agent.SessionPID, agent.SessionStatus)
	}
}
