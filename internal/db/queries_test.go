package db

import (
	"testing"
)

func strptr(s string) *string { return &s }

// newTestStore opens a throwaway on-disk SQLite store in a temp dir.
func newTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	return store
}

func TestBackfillArchivedEndState(t *testing.T) {
	const root = "/tmp/proj"
	store := newTestStore(t)

	// A real killed/merged head from before the EndState column: it ran (session
	// progressed past "pending", an agent status was reported) and was then
	// soft-deleted with an empty EndState. Should be upgraded to "killed".
	if err := store.UpsertAgent(&Agent{
		ID: "ran", ProjectPath: root, AgentType: "claude",
		SessionStatus: "stopped", AgentStatus: strptr("waiting"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SoftDeleteAgent("ran"); err != nil {
		t.Fatal(err)
	}

	// An aborted spawn: failed before the session started, so it stays
	// session_status "pending" with no agent status. Must NOT be upgraded.
	if err := store.UpsertAgent(&Agent{
		ID: "aborted", ProjectPath: root, AgentType: "claude",
		SessionStatus: "pending",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SoftDeleteAgent("aborted"); err != nil {
		t.Fatal(err)
	}

	// An ephemeral test head that ran: ephemeral rows are kept out of history.
	if err := store.UpsertAgent(&Agent{
		ID: "ephemeral", ProjectPath: root, AgentType: "claude", Ephemeral: true,
		SessionStatus: "stopped", AgentStatus: strptr("stopped"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SoftDeleteAgent("ephemeral"); err != nil {
		t.Fatal(err)
	}

	// An already-archived head (recorded EndState). Must be left untouched.
	if err := store.UpsertAgent(&Agent{
		ID: "merged", ProjectPath: root, AgentType: "claude",
		SessionStatus: "stopped", AgentStatus: strptr("stopped"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.ArchiveAgent("merged", "merged"); err != nil {
		t.Fatal(err)
	}

	// An active (not soft-deleted) head. Must be left untouched.
	if err := store.UpsertAgent(&Agent{
		ID: "active", ProjectPath: root, AgentType: "claude",
		SessionStatus: "running", AgentStatus: strptr("running"),
	}); err != nil {
		t.Fatal(err)
	}

	n, err := store.BackfillArchivedEndState()
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 row upgraded, got %d", n)
	}

	archived, err := store.ListArchivedAgents(root, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, a := range archived {
		got[a.ID] = a.EndState
	}
	if got["ran"] != "killed" {
		t.Errorf("ran: expected end_state \"killed\", got %q (present=%v)", got["ran"], got)
	}
	if got["merged"] != "merged" {
		t.Errorf("merged: expected end_state \"merged\" preserved, got %q", got["merged"])
	}
	if _, ok := got["aborted"]; ok {
		t.Errorf("aborted spawn should not have been upgraded into history")
	}
	if _, ok := got["ephemeral"]; ok {
		t.Errorf("ephemeral head should not appear in history")
	}
	if _, ok := got["active"]; ok {
		t.Errorf("active head should not appear in history")
	}

	// Idempotent: a second run upgrades nothing.
	n2, err := store.BackfillArchivedEndState()
	if err != nil {
		t.Fatal(err)
	}
	if n2 != 0 {
		t.Errorf("expected 0 rows on second run, got %d", n2)
	}
}
