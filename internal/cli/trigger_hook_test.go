package cli

import (
	"path/filepath"
	"testing"
)

func TestStatusFilePathHonorsEnv(t *testing.T) {
	t.Setenv("HYDRA_STATUS_PATH", "/proj/.hydra/status/abc.json")
	got, err := statusFilePath()
	if err != nil {
		t.Fatal(err)
	}
	if got != "/proj/.hydra/status/abc.json" {
		t.Errorf("statusFilePath = %q, want the HYDRA_STATUS_PATH value", got)
	}
}

func TestStatusFilePathFallback(t *testing.T) {
	t.Setenv("HYDRA_STATUS_PATH", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	got, err := statusFilePath()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, ".hydra", "status.json"); got != want {
		t.Errorf("statusFilePath = %q, want %q", got, want)
	}
}

func TestStatusLogFilePathHonorsEnv(t *testing.T) {
	t.Setenv("HYDRA_STATUS_LOG_PATH", "/proj/.hydra/status/abc.jsonl")
	got, err := statusLogFilePath()
	if err != nil {
		t.Fatal(err)
	}
	if got != "/proj/.hydra/status/abc.jsonl" {
		t.Errorf("statusLogFilePath = %q, want the HYDRA_STATUS_LOG_PATH value", got)
	}
}
