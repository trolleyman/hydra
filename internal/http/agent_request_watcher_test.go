package http

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/agentq"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
)

type collaborationPTY struct {
	mu     sync.Mutex
	writes strings.Builder
	done   chan struct{}
}

func newCollaborationPTY() *collaborationPTY         { return &collaborationPTY{done: make(chan struct{})} }
func (p *collaborationPTY) Read([]byte) (int, error) { <-p.done; return 0, errtrace.Wrap(io.EOF) }
func (p *collaborationPTY) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return errtrace.Wrap2(p.writes.Write(b))
}
func (p *collaborationPTY) Close() error {
	select {
	case <-p.done:
	default:
		close(p.done)
	}
	return nil
}
func (p *collaborationPTY) Resize(uint16, uint16) error { return nil }
func (p *collaborationPTY) Wait() error                 { <-p.done; return nil }
func (p *collaborationPTY) Pid() int                    { return 4242 }
func (p *collaborationPTY) Signal(os.Signal) error      { return nil }
func (p *collaborationPTY) String() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.writes.String()
}

func collaborationFixture(t *testing.T) (*Server, string, *collaborationPTY) {
	t.Helper()
	root := t.TempDir()
	store, err := db.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	waiting := "waiting"
	for _, a := range []*db.Agent{
		{ID: "source", Title: "Source head", ProjectPath: root, AgentType: "claude", ChatMode: true, SessionPID: 11, SessionStatus: "running", AgentStatus: &waiting, BranchName: "hydra/source", BaseBranch: "main", Prompt: "SECRET PROMPT"},
		{ID: "target", Title: "Target head", ProjectPath: root, AgentType: "claude", ChatMode: true, SessionPID: 22, SessionStatus: "running", AgentStatus: &waiting, BranchName: "hydra/target", BaseBranch: "main", PrePrompt: "SECRET PREPROMPT"},
		{ID: "stopped", ProjectPath: root, AgentType: "claude", SessionStatus: "stopped"},
	} {
		if err := store.CreateAgent(a); err != nil {
			t.Fatal(err)
		}
	}
	reg := session.NewRegistry()
	pty := newCollaborationPTY()
	if _, err := reg.StartWithProc("target", sandbox.AgentTypeClaude, root, 24, 80, false, session.KindChat, pty); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pty.Close() })
	queues := heads.NewChatQueueManager(reg, store)
	return &Server{DB: store, Sessions: reg, ChatQueues: queues}, root, pty
}

func TestAgentDiscoveryIsProjectScopedAndRedacted(t *testing.T) {
	s, root, _ := collaborationFixture(t)
	list := s.handleAgentRequest(context.Background(), root, "source", agentq.Request{Op: agentq.OpList})
	if !list.OK || !strings.Contains(list.Message, "id=source") || !strings.Contains(list.Message, "id=target") {
		t.Fatalf("unexpected list result: %+v", list)
	}
	for _, secret := range []string{"SECRET PROMPT", "SECRET PREPROMPT", root} {
		if strings.Contains(list.Message, secret) {
			t.Errorf("list leaked %q: %s", secret, list.Message)
		}
	}
	if strings.Contains(list.Message, "stopped") {
		t.Errorf("list included stopped head: %s", list.Message)
	}
	get := s.handleAgentRequest(context.Background(), root, "source", agentq.Request{Op: agentq.OpGet, Target: "target"})
	if !get.OK || !strings.Contains(get.Message, "Target head") || strings.Contains(get.Message, "SECRET") {
		t.Fatalf("unexpected get result: %+v", get)
	}
}

func TestAgentMessagingRequiresPolicyAndIsAttributed(t *testing.T) {
	s, root, pty := collaborationFixture(t)
	req := agentq.Request{Op: agentq.OpMessage, Target: "target", Body: "Please check commit abc123."}
	if res := s.handleAgentRequest(context.Background(), root, "source", req); res.OK || !strings.Contains(res.Message, "disabled") {
		t.Fatalf("message without policy = %+v", res)
	}
	cfgPath := config.GetProjectConfigPath(root)
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, []byte("[claude.policy]\nagent_messaging = true\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res := s.handleAgentRequest(context.Background(), root, "source", req)
	if !res.OK || !strings.Contains(res.Message, "delivered") || !strings.Contains(res.Message, "correlation_id=") {
		t.Fatalf("enabled message = %+v", res)
	}
	written := pty.String()
	for _, want := range []string{"Message from Hydra agent source", "Please check commit abc123", "correlation_id=", "message_id="} {
		if !strings.Contains(written, want) {
			t.Errorf("delivered content missing %q: %s", want, written)
		}
	}
	if err := os.WriteFile(cfgPath, []byte("[claude.policy]\nagent_messaging = false\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if res := s.handleAgentRequest(context.Background(), root, "source", req); res.OK || !strings.Contains(res.Message, "disabled") {
		t.Fatalf("message after runtime disable = %+v", res)
	}
}

func TestCollaborationChainsAndPairRateAreBounded(t *testing.T) {
	collaborations = collaborationState{}
	correlation, previous := "", ""
	for i := 0; i < agentChainMax; i++ {
		source, target := "a", "b"
		if i%2 == 1 {
			source, target = target, source
		}
		c, id, _, problem := reserveCollaborationMessage("project", source, target, correlation, previous)
		if problem != "" {
			t.Fatalf("message %d rejected: %s", i+1, problem)
		}
		correlation, previous = c, id
	}
	if _, _, _, problem := reserveCollaborationMessage("project", "a", "b", correlation, previous); problem == "" {
		t.Fatal("seventh message in a chain was accepted")
	}
}
