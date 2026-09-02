package sandbox

import (
	"slices"
	"testing"
)

func TestDefaultsKeepSharedCachesAndToolchainsReadOnly(t *testing.T) {
	writable := Defaults().WritablePaths
	for _, path := range []string{"~/.cache", "~/.local/share/mise"} {
		if slices.Contains(writable, path) {
			t.Errorf("shared persistence path %q is writable by default", path)
		}
	}
}

func TestDefaultsExplicitlyReadToolStateAndMaskCredentials(t *testing.T) {
	defaults := Defaults()
	for _, path := range []string{"~/.cache", "~/.local/share/mise", "~/.rustup", "~/Library/Android/sdk"} {
		if !slices.Contains(defaults.ReadablePaths, path) {
			t.Errorf("developer path %q is not readable by default", path)
		}
	}
	for _, path := range []string{"~/.ssh", "~/.config/gh", "~/Library/Keychains", "/Volumes"} {
		if !slices.Contains(defaults.MaskedPaths, path) {
			t.Errorf("credential path %q is not masked as a fail-safe", path)
		}
	}
}
