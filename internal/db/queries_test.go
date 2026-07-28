package db

import (
	"errors"
	"testing"
	"time"
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

func TestSetArchivedEndStateMerged(t *testing.T) {
	const root = "/tmp/proj"
	store := newTestStore(t)

	// A killed head whose branch was actually merged - should be corrected.
	mustArchive(t, store, &Agent{ID: "was-merged", ProjectPath: root, AgentType: "claude", BranchName: "hydra/was-merged"}, "killed")
	// A genuinely killed head (branch not in the merged set) - stays "killed".
	mustArchive(t, store, &Agent{ID: "killed", ProjectPath: root, AgentType: "claude", BranchName: "hydra/killed"}, "killed")
	// Already "merged" - no-op (not counted).
	mustArchive(t, store, &Agent{ID: "merged", ProjectPath: root, AgentType: "claude", BranchName: "hydra/merged"}, "merged")
	// An aborted spawn (empty end_state) whose branch happens to match - must NOT
	// be pulled into history by the merged correction.
	mustArchive(t, store, &Agent{ID: "aborted", ProjectPath: root, AgentType: "claude", BranchName: "hydra/aborted"}, "")
	// A head in a different project with a matching branch - must be untouched.
	mustArchive(t, store, &Agent{ID: "other", ProjectPath: "/tmp/other", AgentType: "claude", BranchName: "hydra/was-merged"}, "killed")

	mergedBranches := []string{"hydra/was-merged", "hydra/merged", "hydra/aborted"}
	n, err := store.SetArchivedEndStateMerged(root, mergedBranches)
	if err != nil {
		t.Fatalf("set merged: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 row corrected, got %d", n)
	}

	endStates := map[string]string{}
	for _, a := range mustList(t, store, root) {
		endStates[a.ID] = a.EndState
	}
	if endStates["was-merged"] != "merged" {
		t.Errorf("was-merged: expected corrected to \"merged\", got %q", endStates["was-merged"])
	}
	if endStates["killed"] != "killed" {
		t.Errorf("killed: expected unchanged \"killed\", got %q", endStates["killed"])
	}
	if _, ok := endStates["aborted"]; ok {
		t.Errorf("aborted spawn (empty end_state) must not be promoted to history")
	}

	// Other-project row stays "killed".
	other := mustList(t, store, "/tmp/other")
	if len(other) != 1 || other[0].EndState != "killed" {
		t.Errorf("other-project row should be untouched, got %+v", other)
	}

	// Empty branch list is a no-op.
	if n0, err := store.SetArchivedEndStateMerged(root, nil); err != nil || n0 != 0 {
		t.Errorf("empty branch list: expected (0,nil), got (%d,%v)", n0, err)
	}
}

func TestHardDeleteAgent(t *testing.T) {
	const root = "/tmp/proj"
	store := newTestStore(t)

	mustArchive(t, store, &Agent{ID: "gone", ProjectPath: root, AgentType: "claude", BranchName: "hydra/gone"}, "killed")
	if len(mustList(t, store, root)) != 1 {
		t.Fatal("setup: expected 1 archived row")
	}

	if err := store.HardDeleteAgent("gone"); err != nil {
		t.Fatalf("hard delete: %v", err)
	}
	if got := mustList(t, store, root); len(got) != 0 {
		t.Errorf("expected row erased from history, got %+v", got)
	}
	// Even an Unscoped archived lookup must not find it.
	if a, err := store.GetArchivedAgent("gone"); err != nil || a != nil {
		t.Errorf("expected no archived record, got (%+v, %v)", a, err)
	}
}

// The history list is ordered by when a head was archived (killed/merged), not
// by when it was spawned: a long-lived head closed today belongs above a short
// one spawned after it and closed last week.
func TestListArchivedAgentsOrdersByArchiveTime(t *testing.T) {
	const root = "/tmp/proj"
	store := newTestStore(t)

	now := time.Now().UTC().Truncate(time.Second)
	// created / archived offsets (hours ago) chosen so the two orderings differ.
	seed := []struct {
		id                string
		createdH, closedH int
	}{
		{"old-head-closed-today", 300, 1},
		{"new-head-closed-last-week", 10, 170},
		{"mid-head-closed-yesterday", 100, 25},
	}
	for _, s := range seed {
		mustArchive(t, store, &Agent{
			ID: s.id, ProjectPath: root, AgentType: "claude",
			CreatedAt: now.Add(-time.Duration(s.createdH) * time.Hour),
		}, "merged")
		// ArchiveAgent stamps deleted_at with the wall clock, so all three land
		// in the same instant here - rewrite it to the intended archive time.
		if err := store.db.Unscoped().Model(&Agent{}).Where("id = ?", s.id).
			Update("deleted_at", now.Add(-time.Duration(s.closedH)*time.Hour)).Error; err != nil {
			t.Fatal(err)
		}
	}

	want := []string{"old-head-closed-today", "mid-head-closed-yesterday", "new-head-closed-last-week"}
	var got []string
	for _, a := range mustList(t, store, root) {
		got = append(got, a.ID)
	}
	if len(got) != len(want) {
		t.Fatalf("expected %d archived rows, got %v", len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("archived order = %v, want %v (newest-archived first)", got, want)
		}
	}

	// Paging must follow the same order.
	page, err := store.ListArchivedAgents(root, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 1 || page[0].ID != want[1] {
		t.Errorf("limit=1 offset=1 returned %+v, want just %q", page, want[1])
	}
}

func mustArchive(t *testing.T, store *Store, a *Agent, endState string) {
	t.Helper()
	if err := store.UpsertAgent(a); err != nil {
		t.Fatal(err)
	}
	if endState == "" {
		if err := store.SoftDeleteAgent(a.ID); err != nil {
			t.Fatal(err)
		}
		return
	}
	if err := store.ArchiveAgent(a.ID, endState); err != nil {
		t.Fatal(err)
	}
}

func mustList(t *testing.T, store *Store, root string) []Agent {
	t.Helper()
	rows, err := store.ListArchivedAgents(root, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func TestCreateAgentRefusesTakenID(t *testing.T) {
	store := newTestStore(t)

	if err := store.CreateAgent(&Agent{ID: "head", ProjectPath: "/tmp/proj-a", AgentType: "claude"}); err != nil {
		t.Fatalf("first create: %v", err)
	}

	// Same ID from another project must NOT steal the record (the ID is a
	// global primary key across every project in the shared DB).
	err := store.CreateAgent(&Agent{ID: "head", ProjectPath: "/tmp/proj-b", AgentType: "claude"})
	if !errors.Is(err, ErrAgentIDTaken) {
		t.Fatalf("cross-project create: got %v, want ErrAgentIDTaken", err)
	}
	if a, err := store.GetAgent("head"); err != nil || a == nil || a.ProjectPath != "/tmp/proj-a" {
		t.Fatalf("original record was disturbed: (%+v, %v)", a, err)
	}

	// An archived (soft-deleted) record still holds the ID.
	if err := store.ArchiveAgent("head", "killed"); err != nil {
		t.Fatal(err)
	}
	err = store.CreateAgent(&Agent{ID: "head", ProjectPath: "/tmp/proj-a", AgentType: "claude"})
	if !errors.Is(err, ErrAgentIDTaken) {
		t.Fatalf("archived-collision create: got %v, want ErrAgentIDTaken", err)
	}
}

func TestUnarchiveAgent(t *testing.T) {
	store := newTestStore(t)

	orig := &Agent{
		ID:              "head",
		ProjectPath:     "/tmp/proj",
		AgentType:       "claude",
		Prompt:          "do the thing",
		Title:           "Do the thing",
		BaseBranch:      "main",
		AgentStatus:     strptr("running"),
		AgentStatusTime: "2026-07-09T00:00:00Z",
		SessionPID:      4242,
		LastError:       strptr("boom"),
	}
	mustArchive(t, store, orig, "killed")

	// Precondition: it is archived and hidden from the active view.
	if a, err := store.GetAgent("head"); err != nil || a != nil {
		t.Fatalf("archived head should be hidden from GetAgent: (%+v, %v)", a, err)
	}
	if a, err := store.GetArchivedAgent("head"); err != nil || a == nil {
		t.Fatalf("archived head should be listed by GetArchivedAgent: (%+v, %v)", a, err)
	}

	if err := store.UnarchiveAgent("head"); err != nil {
		t.Fatalf("unarchive: %v", err)
	}

	// It is active again (not in the archived list, visible to GetAgent).
	if a, err := store.GetArchivedAgent("head"); err != nil || a != nil {
		t.Fatalf("unarchived head should no longer be archived: (%+v, %v)", a, err)
	}
	a, err := store.GetAgent("head")
	if err != nil || a == nil {
		t.Fatalf("unarchived head should be active: (%+v, %v)", a, err)
	}

	// Transient session/operation fields are reset...
	if a.EndState != "" {
		t.Errorf("end_state: got %q, want empty", a.EndState)
	}
	if a.SessionStatus != "pending" {
		t.Errorf("session_status: got %q, want pending", a.SessionStatus)
	}
	if a.SessionPID != 0 {
		t.Errorf("session_pid: got %d, want 0", a.SessionPID)
	}
	if a.HeadStatus != "idle" {
		t.Errorf("head_status: got %q, want idle", a.HeadStatus)
	}
	if a.LastError != nil {
		t.Errorf("last_error: got %v, want nil", a.LastError)
	}

	// ...while the identity + the last-known AgentStatus the resume nudge reads
	// are preserved.
	if a.Prompt != "do the thing" || a.Title != "Do the thing" || a.BaseBranch != "main" {
		t.Errorf("identity fields not preserved: %+v", a)
	}
	if a.AgentStatus == nil || *a.AgentStatus != "running" {
		t.Errorf("agent_status not preserved: %v", a.AgentStatus)
	}
}

func TestGetAgentAny(t *testing.T) {
	store := newTestStore(t)

	if a, err := store.GetAgentAny("missing"); err != nil || a != nil {
		t.Fatalf("missing: got (%+v, %v), want (nil, nil)", a, err)
	}

	mustArchive(t, store, &Agent{ID: "head", ProjectPath: "/tmp/proj", AgentType: "claude"}, "killed")
	// Archived rows are invisible to GetAgent but must be visible to GetAgentAny.
	if a, err := store.GetAgent("head"); err != nil || a != nil {
		t.Fatalf("GetAgent should not see archived rows: (%+v, %v)", a, err)
	}
	a, err := store.GetAgentAny("head")
	if err != nil || a == nil || !a.DeletedAt.Valid {
		t.Fatalf("GetAgentAny: got (%+v, %v), want archived record", a, err)
	}
}
