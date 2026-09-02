package http

import (
	"testing"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestSpawnEffort(t *testing.T) {
	high := api.SpawnAgentRequestEffort("high")
	bogus := api.SpawnAgentRequestEffort("bogus")
	tests := []struct {
		name    string
		agent   sandbox.AgentType
		value   *api.SpawnAgentRequestEffort
		want    string
		wantErr bool
	}{
		{"omitted", sandbox.AgentTypeClaude, nil, "", false},
		{"claude", sandbox.AgentTypeClaude, &high, "high", false},
		{"codex", sandbox.AgentTypeCodex, &high, "high", false},
		{"unsupported provider", sandbox.AgentTypeGemini, &high, "", true},
		{"unknown value", sandbox.AgentTypeCodex, &bogus, "", true},
	}
	for _, tt := range tests {
		got, err := spawnEffort(tt.agent, tt.value)
		if got != tt.want || (err != nil) != tt.wantErr {
			t.Errorf("%s: got (%q, %v), want (%q, error=%v)", tt.name, got, err, tt.want, tt.wantErr)
		}
	}
}
