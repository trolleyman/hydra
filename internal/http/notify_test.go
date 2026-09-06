package http

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/session"
)

// Every automated notice is addressed by project ROOT, because that is what its
// caller holds. Routing them through the HTTP handler instead put a root in the
// field that carries the project ID from the URL - which type-checks, resolves
// nothing, and turned each notice into a logged "project not found: /path" while
// the publish that triggered it still reported success to the user.
//
// The guard: a Server with NO ProjectsManager at all, so an ID lookup could not
// possibly succeed. Delivery must still get as far as the head's session.
func TestSendAgentInputAddressesHeadsByRoot(t *testing.T) {
	projectRoot := t.TempDir()
	store, err := db.Open(projectRoot)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := store.CreateAgent(&db.Agent{
		ID: "head", ProjectPath: projectRoot,
		// A PID makes the head "running" as far as the lookup is concerned; there
		// is no PTY behind it, so the write below is what fails - and that is the
		// point, it means we got past resolution to the delivery itself.
		SessionPID: 4242, SessionStatus: "running",
	}); err != nil {
		t.Fatalf("create agent: %v", err)
	}

	s := &Server{DB: store, Sessions: session.NewRegistry()}
	err = s.sendAgentInput(context.Background(), projectRoot, "head", "[Hydra] New review comment: #1.", api.MessageOriginHydra, reasonReviewComments)
	if err == nil {
		t.Fatal("a head with no live session should not have accepted the write")
	}
	if errors.Is(err, errAgentNotRunning) || strings.Contains(err.Error(), "project not found") {
		t.Fatalf("the notice never reached the head - it died during lookup: %v", err)
	}
	if !strings.Contains(err.Error(), "stdin") {
		t.Errorf("expected the failure to come from the session write, got: %v", err)
	}
}

// The head is addressed by id, not by whatever the caller happens to be holding:
// an unknown head is "not running", which the publish path reports rather than
// swallowing.
func TestSendAgentInputReportsAMissingHead(t *testing.T) {
	projectRoot := t.TempDir()
	store, err := db.Open(projectRoot)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	s := &Server{DB: store, Sessions: session.NewRegistry()}
	if err := s.sendAgentInput(context.Background(), projectRoot, "gone", "hi", "", ""); !errors.Is(err, errAgentNotRunning) {
		t.Fatalf("want errAgentNotRunning, got %v", err)
	}
}
