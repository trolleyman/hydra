package desktop

import (
	"context"
	"strings"
	"testing"
)

func TestApplyDeepLink(t *testing.T) {
	base := "http://127.0.0.1:4321/#desktop-bootstrap=secret"
	tests := map[string]string{
		"hydra://settings":                        "/settings",
		"hydra://project/my-project":              "/project/my-project",
		"hydra://project/my-project/agent/head.2": "/project/my-project/agent/head.2",
		"hydra://focused/_chat":                   "/focused/_chat",
	}
	for link, path := range tests {
		got, err := ApplyDeepLink(base, link)
		if err != nil {
			t.Fatalf("ApplyDeepLink(%q): %v", link, err)
		}
		if !strings.Contains(got, path) || !strings.Contains(got, "desktop-bootstrap=secret") {
			t.Errorf("ApplyDeepLink(%q) = %q", link, got)
		}
	}
}

func TestApplyDeepLinkRejectsUnsafeInput(t *testing.T) {
	for _, link := range []string{"https://example.com", "hydra://project/../etc", "hydra://run/rm", "hydra://settings?x=1"} {
		if _, err := ApplyDeepLink("http://127.0.0.1:4321", link); err == nil {
			t.Errorf("ApplyDeepLink accepted %q", link)
		}
	}
}

func TestLocalServerURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{name: "empty", url: "", wantErr: true},
		{name: "IPv4", url: "http://127.0.0.1:49152/project/demo"},
		{name: "IPv6", url: "http://[::1]:49152"},
		{name: "localhost", url: "https://localhost:49152"},
		{name: "localhost trailing dot", url: "http://localhost.:49152"},
		{name: "remote host", url: "https://example.com", wantErr: true},
		{name: "loopback lookalike", url: "https://localhost.example.com", wantErr: true},
		{name: "credentials", url: "http://token@localhost:49152", wantErr: true},
		{name: "file", url: "file:///tmp/index.html", wantErr: true},
		{name: "missing scheme", url: "localhost:49152", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := localServerURL(tt.url)
			if (err != nil) != tt.wantErr {
				t.Fatalf("localServerURL(%q) error = %v, wantErr %v", tt.url, err, tt.wantErr)
			}
		})
	}
}

func TestResolveServerExplicitURL(t *testing.T) {
	t.Parallel()
	got, err := ResolveServer(context.Background(), "http://127.0.0.1:49152", "")
	if err != nil {
		t.Fatalf("ResolveServer: %v", err)
	}
	if want := "http://127.0.0.1:49152"; got != want {
		t.Fatalf("ResolveServer = %q, want %q", got, want)
	}
}

func TestResolveServerRejectsURLAndProjectTogether(t *testing.T) {
	t.Parallel()
	if _, err := ResolveServer(context.Background(), "http://localhost:49152", t.TempDir()); err == nil {
		t.Fatal("ResolveServer accepted both URL and project")
	}
}
