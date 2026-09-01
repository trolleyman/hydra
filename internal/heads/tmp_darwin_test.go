//go:build darwin

package heads

import (
	"strings"
	"testing"
)

func TestWithPrivateTempPromptNamesDarwinPath(t *testing.T) {
	tmpDir := "/project/.hydra/local/projects/example/tmp/head-one"
	got := withPrivateTempPrompt("base prompt\n", tmpDir)
	for _, want := range []string{"base prompt", "`$TMPDIR`", "`" + tmpDir + "`", "Shared host `/tmp` is inaccessible"} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt lacks %q: %q", want, got)
		}
	}
}
