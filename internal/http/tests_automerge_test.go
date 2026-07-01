package http

import (
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/db"
)

// TestHeadFinishedFor covers the auto-merge finished-gate: merge-when-green only
// fires once the agent has genuinely settled into finished (session alive) for
// the dwell window. A still-working/blocked head, a stopped session, a too-recent
// finish, and a missing timestamp all keep it waiting.
func TestHeadFinishedFor(t *testing.T) {
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	s := func(v string) *string { return &v }
	old := now.Add(-30 * time.Second).Format(time.RFC3339Nano)
	recent := now.Add(-2 * time.Second).Format(time.RFC3339Nano)

	cases := []struct {
		name string
		a    db.Agent
		want bool
	}{
		{"finished long enough", db.Agent{SessionStatus: "running", AgentStatus: s("finished"), AgentStatusTime: old}, true},
		{"finished too recently", db.Agent{SessionStatus: "running", AgentStatus: s("finished"), AgentStatusTime: recent}, false},
		{"still running", db.Agent{SessionStatus: "running", AgentStatus: s("running"), AgentStatusTime: old}, false},
		{"needs input", db.Agent{SessionStatus: "running", AgentStatus: s("needs_input"), AgentStatusTime: old}, false},
		{"waiting", db.Agent{SessionStatus: "running", AgentStatus: s("waiting"), AgentStatusTime: old}, false},
		{"session stopped", db.Agent{SessionStatus: "stopped", AgentStatus: s("finished"), AgentStatusTime: old}, false},
		{"nil status", db.Agent{SessionStatus: "running", AgentStatus: nil, AgentStatusTime: old}, false},
		{"unparseable time", db.Agent{SessionStatus: "running", AgentStatus: s("finished"), AgentStatusTime: "not-a-time"}, false},
		{"empty time", db.Agent{SessionStatus: "running", AgentStatus: s("finished"), AgentStatusTime: ""}, false},
	}
	for _, c := range cases {
		if got := headFinishedFor(c.a, autoMergeFinishedDwell, now); got != c.want {
			t.Errorf("%s: headFinishedFor = %v, want %v", c.name, got, c.want)
		}
	}
}
