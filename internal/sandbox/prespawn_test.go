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

	// Script set, no shebang: defaults to /bin/bash -c, exec'ing argv via "$@".
	got := withPreSpawn("mise trust", argv)
	want := []string{"/bin/bash", "-c", "mise trust\nexec \"$@\"", "hydra-pre-spawn", "claude", "--dangerously-skip-permissions"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("wrapped argv:\n got %#v\nwant %#v", got, want)
	}

	// A shebang selects the interpreter (here zsh); the script body, shebang line
	// included, is passed verbatim to `-c`.
	body := "#!/bin/zsh\nset -o pipefail\nmise trust"
	got = withPreSpawn(body, argv)
	want = []string{"/bin/zsh", "-c", body + "\nexec \"$@\"", "hydra-pre-spawn", "claude", "--dangerously-skip-permissions"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("zsh shebang:\n got %#v\nwant %#v", got, want)
	}

	// `#!/usr/bin/env bash` keeps both fields, so it runs as `env bash -c …`.
	got = withPreSpawn("#!/usr/bin/env bash\necho hi", argv)
	if len(got) < 3 || got[0] != "/usr/bin/env" || got[1] != "bash" || got[2] != "-c" {
		t.Errorf("env shebang: got %#v", got)
	}
}

func TestPreSpawnInterp(t *testing.T) {
	cases := []struct {
		script string
		want   []string
	}{
		{"mise trust", []string{"/bin/bash"}},
		{"\n\n  echo hi", []string{"/bin/bash"}},                              // leading blank lines, no shebang
		{"#!/bin/zsh\necho hi", []string{"/bin/zsh"}},                         // simple shebang
		{"  \n#!/bin/sh", []string{"/bin/sh"}},                                // leading blank lines before #! are tolerated
		{"# a comment\n#!/bin/sh", []string{"/bin/bash"}},                     // #! after a real line → not a shebang
		{"#!/usr/bin/env bash -e\nx", []string{"/usr/bin/env", "bash", "-e"}}, // args preserved
		{"#!\nx", []string{"/bin/bash"}},                                      // empty shebang → default
	}
	for _, c := range cases {
		if got := preSpawnInterp(c.script); !reflect.DeepEqual(got, c.want) {
			t.Errorf("preSpawnInterp(%q) = %#v, want %#v", c.script, got, c.want)
		}
	}
}
