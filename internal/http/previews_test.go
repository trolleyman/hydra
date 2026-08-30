package http

import (
	"context"
	"net/http"
	"os/exec"
	"testing"
)

func ctxWithHost(host string) context.Context {
	return context.WithValue(context.Background(), requestCtxKey{}, &http.Request{Host: host})
}

func TestResolvePreviewBranchMissingDuringHeadTeardown(t *testing.T) {
	root := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Test"},
		{"commit", "--allow-empty", "-qm", "initial"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", root}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}

	sha, exists, err := resolvePreviewBranch(root, "hydra/just-killed")
	if err != nil {
		t.Fatalf("resolve missing branch: %v", err)
	}
	if exists || sha != "" {
		t.Fatalf("missing branch resolved as sha=%q exists=%v", sha, exists)
	}

	if out, err := exec.Command("git", "-C", root, "branch", "hydra/live").CombinedOutput(); err != nil {
		t.Fatalf("create live branch: %v: %s", err, out)
	}
	sha, exists, err = resolvePreviewBranch(root, "hydra/live")
	if err != nil || !exists || sha == "" {
		t.Fatalf("resolve live branch = sha=%q exists=%v err=%v", sha, exists, err)
	}
}

// TestPreviewURL pins the protocol-relative "//host:port/" shape: the link must
// follow the page's scheme (http on the LAN, https behind a TLS front) rather
// than a hardcoded http://, which an https page would block as mixed content.
func TestPreviewURL(t *testing.T) {
	cases := []struct {
		name string
		ctx  context.Context
		port int
		want string // "" means nil
	}{
		{"host with port", ctxWithHost("hades:26600"), 26601, "//hades:26601/"},
		{"host without port", ctxWithHost("example.ts.net"), 26601, "//example.ts.net:26601/"},
		{"no request falls back to localhost", context.Background(), 26602, "//localhost:26602/"},
		{"port zero is nil", context.Background(), 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := previewURL(tc.ctx, tc.port)
			if tc.want == "" {
				if got != nil {
					t.Fatalf("previewURL = %q, want nil", *got)
				}
				return
			}
			if got == nil {
				t.Fatalf("previewURL = nil, want %q", tc.want)
			}
			if *got != tc.want {
				t.Fatalf("previewURL = %q, want %q", *got, tc.want)
			}
		})
	}
}
