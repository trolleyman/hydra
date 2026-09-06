//go:build darwin

package heads

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/statepath"
)

func TestMain(m *testing.M) {
	stateRoot, err := os.MkdirTemp("", "hydra-heads-test-state-*")
	if err != nil {
		panic(err)
	}
	if err := os.Setenv(statepath.Environment, stateRoot); err != nil {
		panic(err)
	}
	code := m.Run()
	_ = os.RemoveAll(stateRoot)
	os.Exit(code)
}

func TestStageHydraRuntimeIsSharedAndImmutableInput(t *testing.T) {
	stateRoot := t.TempDir()
	t.Setenv(statepath.Environment, stateRoot)

	first, err := stageHydraRuntime()
	if err != nil {
		t.Fatal(err)
	}
	second, err := stageHydraRuntime()
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("staged paths differ: %q != %q", first, second)
	}
	if filepath.Dir(filepath.Dir(first)) != filepath.Join(stateRoot, "runtime") {
		t.Fatalf("staged path %q is outside the runtime directory", first)
	}

	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	sourceData, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	stagedData, err := os.ReadFile(first)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(sourceData, stagedData) {
		t.Fatal("staged runtime differs from the running executable")
	}
	if info, err := os.Stat(first); err != nil {
		t.Fatal(err)
	} else if info.Mode().Perm() != 0o500 {
		t.Fatalf("staged runtime mode = %o, want 500", info.Mode().Perm())
	}
}
