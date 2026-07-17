//go:build !hydra_no_frontend

package cli

import (
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// The embedded frontend must send explicit cache headers: embed.FS files have
// no modtime, so without them the browser heuristically caches index.html and
// keeps showing the OLD app after a rebuild+restart. Hashed bundles are
// immutable; stable-named files (index.html, icons) must revalidate.
func TestSpaHandlerCacheHeaders(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":         {Data: []byte("<html>app</html>")},
		"icon.png":           {Data: []byte("png")},
		"assets/app-abc.js":  {Data: []byte("js")},
		"assets/app-abc.css": {Data: []byte("css")},
	}
	h := spaHandler(fsys)

	cases := []struct {
		path, want string
	}{
		{"/", "no-cache"},
		{"/index.html", "no-cache"},
		{"/icon.png", "no-cache"},
		{"/assets/app-abc.js", "public, max-age=31536000, immutable"},
		{"/assets/app-abc.css", "public, max-age=31536000, immutable"},
		// SPA fallback (client route -> index.html) must revalidate too.
		{"/project/p1/agent/a1", "no-cache"},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest("GET", c.path, nil))
		if got := rec.Header().Get("Cache-Control"); got != c.want {
			t.Errorf("GET %s: Cache-Control = %q, want %q", c.path, got, c.want)
		}
	}
}
