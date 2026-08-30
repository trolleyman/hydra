package cli

import (
	"testing"

	"github.com/trolleyman/hydra/internal/db"
)

func TestServiceActiveAgentCount(t *testing.T) {
	tests := []struct {
		name   string
		status string
		want   int
	}{
		{name: "pending", status: "pending", want: 1},
		{name: "building", status: "building", want: 1},
		{name: "starting", status: "starting", want: 1},
		{name: "running", status: "running", want: 1},
		{name: "stopped", status: "stopped", want: 0},
		{name: "legacy empty", status: "", want: 0},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			agents := []db.Agent{{ID: "head", SessionStatus: test.status}}
			if got := serviceActiveAgentCount(agents); got != test.want {
				t.Fatalf("serviceActiveAgentCount() = %d, want %d", got, test.want)
			}
		})
	}
}
