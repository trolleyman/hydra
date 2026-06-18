package heads

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/paths"
)

func TestKillHeadNoLock_RemovesLogs(t *testing.T) {
	tmpDir := t.TempDir()
	projectRoot := tmpDir
	agentID := "test-agent"

	// Create the status directory
	statusDir := paths.GetStatusDirFromProjectRoot(projectRoot)
	if err := os.MkdirAll(statusDir, 0755); err != nil {
		t.Fatalf("failed to create status dir: %v", err)
	}

	// Create dummy files
	statusJson := paths.GetStatusJsonFromProjectRoot(projectRoot, agentID)
	statusLog := paths.GetStatusLogFromProjectRoot(projectRoot, agentID)
	buildLog := paths.GetBuildLogFromProjectRoot(projectRoot, agentID)

	files := []string{statusJson, statusLog, buildLog}
	for _, f := range files {
		if err := os.WriteFile(f, []byte("dummy"), 0644); err != nil {
			t.Fatalf("failed to create dummy file %s: %v", f, err)
		}
	}

	head := Head{
		ID:          agentID,
		ProjectPath: projectRoot,
	}

	// Call KillHeadNoLock with nil cli and store
	err := KillHeadNoLock(context.Background(), nil, nil, head, "killed")
	if err != nil {
		t.Fatalf("KillHeadNoLock failed: %v", err)
	}

	// Check if files are removed
	for _, f := range files {
		if _, err := os.Stat(f); !os.IsNotExist(err) {
			t.Errorf("file %s still exists after KillHeadNoLock", f)
		}
	}
}

func TestHeadContextEnv(t *testing.T) {
	got := headContextEnv("abc123", "claude", "/repo", "/repo/.hydra/worktrees/abc123", "hydra/abc123", "main")
	want := map[string]string{
		"HYDRA_HEAD_ID":      "abc123",
		"HYDRA_AGENT_TYPE":   "claude",
		"HYDRA_PROJECT_ROOT": "/repo",
		"HYDRA_WORKTREE":     "/repo/.hydra/worktrees/abc123",
		"HYDRA_BRANCH":       "hydra/abc123",
		"HYDRA_BASE_BRANCH":  "main",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d vars, want %d: %v", len(got), len(want), got)
	}
	for _, kv := range got {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			t.Fatalf("malformed env entry %q", kv)
		}
		if w, present := want[k]; !present {
			t.Errorf("unexpected var %q", k)
		} else if v != w {
			t.Errorf("%s = %q, want %q", k, v, w)
		}
		// Every variable must be owned by Hydra so it can't leak from the host.
		if !envKeysHydraOwns[k] {
			t.Errorf("%s missing from envKeysHydraOwns", k)
		}
	}
}

func TestDerefStr(t *testing.T) {
	if got := derefStr(nil); got != "" {
		t.Errorf("derefStr(nil) = %q, want \"\"", got)
	}
	s := "x"
	if got := derefStr(&s); got != "x" {
		t.Errorf("derefStr(&\"x\") = %q, want \"x\"", got)
	}
}
