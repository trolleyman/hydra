package desktop

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLinuxDesktopEntryMatchesApplicationID(t *testing.T) {
	t.Setenv(LaunchConfigEnv, "")
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

func TestLinuxApplicationIDUsesSeparateDevelopmentIdentity(t *testing.T) {
	t.Setenv(LaunchConfigEnv, "")
	if got := LinuxApplicationID(); got != linuxApplicationID {
		t.Fatalf("installed application ID = %q, want %q", got, linuxApplicationID)
	}

	if err := SetLaunchConfig(LaunchConfig{State: "global", BackendLifetime: "command-owned", Build: "development"}); err != nil {
		t.Fatal(err)
	}
	if got := LinuxApplicationID(); got != linuxDevelopmentApplicationID {
		t.Fatalf("development application ID = %q, want %q", got, linuxDevelopmentApplicationID)
	}
}
