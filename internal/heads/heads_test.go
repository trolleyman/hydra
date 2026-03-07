package heads

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/paths"
)

func TestKillHeadNoLock_RemovesLogs(t *testing.T) {
	tmpDir := t.TempDir()
	projectRoot := tmpDir
	agentID := "test-agent"

	// Create .hydra/status directory
	statusDir := filepath.Join(projectRoot, ".hydra", "status")
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
	err := KillHeadNoLock(context.Background(), nil, nil, head)
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
