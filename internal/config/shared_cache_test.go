package config

import (
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestSharedCacheDecodeMergeAndRender(t *testing.T) {
	cfg, err := decodeConfig([]byte(`[sandbox.cache]
go_build = { env = "GOCACHE" }
web = { path = "web/cache" }

[codex.sandbox.cache]
go_build = { env = "CODEX_GO_CACHE" }
`))
	if err != nil {
		t.Fatal(err)
	}
	resolved := cfg.ResolveSharedCaches("codex")
	if got := resolved["go_build"].Env; got != "CODEX_GO_CACHE" {
		t.Fatalf("overridden cache env = %q", got)
	}
	if got := resolved["web"].Path; got != "web/cache" {
		t.Fatalf("inherited path cache = %q", got)
	}
	rendered := renderConfig(nil, cfg)
	for _, want := range []string{"[sandbox.cache]", `go_build = { env = "GOCACHE" }`, `web = { path = "web/cache" }`, "[codex.sandbox.cache]"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("rendered config missing %q:\n%s", want, rendered)
		}
	}
	second := renderConfig([]byte(rendered), cfg)
	if rendered != second {
		t.Fatalf("cache rendering is not idempotent:\n%s", second)
	}
}

func TestSharedCacheValidation(t *testing.T) {
	for name, entry := range map[string]sandbox.SharedCache{
		"both":        {Env: "GOCACHE", Path: "cache"},
		"neither":     {},
		"parent":      {Path: "../cache"},
		"gobin":       {Env: "GOBIN"},
		"invalid-env": {Env: "BAD-NAME"},
	} {
		if err := ValidateSharedCache(name, entry); err == nil {
			t.Errorf("ValidateSharedCache(%q) unexpectedly succeeded", name)
		}
	}
}
