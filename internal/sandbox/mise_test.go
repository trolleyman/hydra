package sandbox

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestParseMiseTrusted(t *testing.T) {
	const root = "/home/u/proj"
	const home = "/home/u"

	cases := []struct {
		name string
		out  string
		want bool
	}{
		{"trusted exact", "/home/u/proj: trusted\n", true},
		{"trusted with tilde", "~/proj: trusted\n", true},
		{"trusted among others", "~/other: untrusted\n/home/u/proj: trusted\n", true},
		{"untrusted", "/home/u/proj: untrusted\n", false},
		{"project absent", "/somewhere/else: trusted\n", false},
		{"empty output", "", false},
		{"whitespace only", "   \n\t\n", false},
		// "weird output" a wedged or unrelated `mise` might emit: no path/status
		// lines, partial lines, or noise that must never be read as trust.
		{"garbage no colon", "blah blah\nnonsense here\n", false},
		{"colon but not our path", "Error: something went wrong: trusted\n", false},
		{"status not trusted word", "/home/u/proj: trusted-ish\n", false},
		{"json-ish noise", `{"path": "/home/u/proj"}` + "\n", false},
		{"path matches but empty status", "/home/u/proj: \n", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseMiseTrusted(tc.out, root, home); got != tc.want {
				t.Errorf("parseMiseTrusted(%q) = %v, want %v", tc.out, got, tc.want)
			}
		})
	}
}

// TestMiseEnvNoRunDir covers the trust-path early returns without depending on
// the machine running the test having mise installed.
func TestMiseEnvNoRunDir(t *testing.T) {
	if env := miseEnv("/p", "", ""); env != nil {
		t.Errorf("empty runDir: got %v, want nil", env)
	}
	if env := miseEnv("/p", "/p", ""); env != nil {
		t.Errorf("runDir == projectRoot: got %v, want nil", env)
	}
	want := "/home/u/.local/share/mise/bootstrap/mise-2026.8.15"
	if env := miseEnv("/p", "/p", want); len(env) != 1 || env[0] != "MISE_INSTALL_PATH="+want {
		t.Errorf("bootstrap env = %v, want MISE_INSTALL_PATH", env)
	}
}

func TestHostMiseInstallPathUsesExportedExecutable(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "mise")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MISE_INSTALL_PATH", bin)
	if got := hostMiseInstallPath(); got != bin {
		t.Errorf("hostMiseInstallPath() = %q, want %q", got, bin)
	}
}

func TestHostMiseInstallPathResolvesExistingBootstrapOffline(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mise launcher probing uses sh on Unix")
	}
	root := t.TempDir()
	dataDir := filepath.Join(root, "data", "mise")
	bin := filepath.Join(dataDir, "bootstrap", "mise-2026.8.15")
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("bootstrap"), 0o755); err != nil {
		t.Fatal(err)
	}
	launcherDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(launcherDir, 0o755); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(launcherDir, "mise")
	script := "#!/bin/sh\n" +
		"test \"$MISE_OFFLINE\" = 1 || exit 41\n" +
		"test \"$MISE_AUTO_UPDATE\" = 0 || exit 42\n" +
		"printf '%s\\n' '" + bin + "'\n"
	if err := os.WriteFile(launcher, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MISE_INSTALL_PATH", "")
	t.Setenv("MISE_DATA_DIR", dataDir)
	t.Setenv("PATH", launcherDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if got := hostMiseInstallPath(); got != bin {
		t.Errorf("hostMiseInstallPath() = %q, want %q", got, bin)
	}
}
