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
