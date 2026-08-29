package cli

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/trolleyman/hydra/internal/desktopcontract"
)

func TestPublishDesktopReady(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "ready.json")
	t.Setenv(desktopReadyFileEnv, path)
	cleanup, err := publishDesktopReady(&net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 43123}, "one-time-token")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record desktopReadyRecord
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	if record.Protocol != desktopcontract.Protocol || record.URL != "http://127.0.0.1:43123" || record.PID != os.Getpid() || record.BootstrapToken != "one-time-token" {
		t.Fatalf("ready record = %+v", record)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("ready file permissions: info=%v err=%v", info, err)
	}
	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("cleanup left ready file: %v", err)
	}
}

func TestPublishDesktopReadyDisabled(t *testing.T) {
	t.Setenv(desktopReadyFileEnv, "")
	cleanup, err := publishDesktopReady(nil, "token")
	if err != nil {
		t.Fatal(err)
	}
	cleanup()
}
