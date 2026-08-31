package desktop

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLinuxDesktopEntryMatchesApplicationID(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	desktopEntry := filepath.Join(filepath.Dir(filename), "..", "..", "desktop", "linux", linuxApplicationID+".desktop")
	contents, err := os.ReadFile(desktopEntry)
	if err != nil {
		t.Fatalf("read Linux desktop entry: %v", err)
	}

	text := string(contents)
	for _, field := range []string{
		"Icon=" + linuxApplicationID,
		"StartupWMClass=" + linuxApplicationID,
	} {
		if !strings.Contains(text, "\n"+field+"\n") {
			t.Errorf("Linux desktop entry does not contain %q", field)
		}
	}
}
