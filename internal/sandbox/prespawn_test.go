package sandbox

import (
	"reflect"
	"testing"
)

func TestWithPreSpawn(t *testing.T) {
	argv := []string{"claude", "--dangerously-skip-permissions"}

	// No script: argv is returned unchanged.
	if got := withPreSpawn("", argv); !reflect.DeepEqual(got, argv) {
		t.Errorf("empty script: got %v, want %v", got, argv)
	}
	if got := withPreSpawn("   \n\t ", argv); !reflect.DeepEqual(got, argv) {
		t.Errorf("blank script: got %v, want %v", got, argv)
	}

	// Empty argv: nothing to wrap.
	if got := withPreSpawn("echo hi", nil); got != nil {
		t.Errorf("empty argv: got %v, want nil", got)
	}

	// Script set: wraps in /bin/sh -c, exec'ing the original argv via "$@".
	got := withPreSpawn("mise trust", argv)
	want := []string{"/bin/sh", "-c", "mise trust\nexec \"$@\"", "hydra-pre-spawn", "claude", "--dangerously-skip-permissions"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("wrapped argv:\n got %#v\nwant %#v", got, want)
	}
}
