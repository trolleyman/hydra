//go:build !hydra_no_frontend

package cli

import (
	"bytes"
	"compress/gzip"
	"net/http/httptest"
	"strings"
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

// gzipBytes is the encoded form the build step would have written to disk.
func gzipBytes(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(s)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// precompressedFS mirrors what web/scripts/precompress.ts leaves behind: the
// original is GONE, replaced by its two encodings. Everything below turns on
// that, since a handler that only looked for the original would 404 the whole app.
func precompressedFS(t *testing.T) fstest.MapFS {
	t.Helper()
	return fstest.MapFS{
		"index.html.br":         {Data: []byte("brotli-index")},
		"index.html.gz":         {Data: gzipBytes(t, "<html>app</html>")},
		"assets/app-abc.js.br":  {Data: []byte("brotli-js")},
		"assets/app-abc.js.gz":  {Data: gzipBytes(t, "console.log(1)")},
		"assets/app-abc.js.map": {Data: []byte(`{"version":3}`)}, // under the size floor: left as-is
		"icon.png":              {Data: []byte("png-bytes")},     // never compressed
	}
}

func TestServesBestEncodingClientAccepts(t *testing.T) {
	h := spaHandler(precompressedFS(t))

	cases := []struct {
		name, accept, wantEncoding, wantBody string
	}{
		{"prefers brotli", "gzip, deflate, br", "br", "brotli-js"},
		{"falls back to gzip", "gzip, deflate", "gzip", ""},
		{"identity when nothing is accepted", "", "", "console.log(1)"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/assets/app-abc.js", nil)
			if c.accept != "" {
				req.Header.Set("Accept-Encoding", c.accept)
			}
			rec := httptest.NewRecorder()
			h(rec, req)

			if got := rec.Header().Get("Content-Encoding"); got != c.wantEncoding {
				t.Errorf("Content-Encoding = %q, want %q", got, c.wantEncoding)
			}
			if c.wantBody != "" && rec.Body.String() != c.wantBody {
				t.Errorf("body = %q, want %q", rec.Body.String(), c.wantBody)
			}
			// The variant's own extension must never reach the browser.
			if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
				t.Errorf("Content-Type = %q, want a javascript type - the .br/.gz suffix leaked", ct)
			}
			if v := rec.Header().Get("Vary"); !strings.Contains(v, "Accept-Encoding") {
				t.Errorf("Vary = %q, want Accept-Encoding", v)
			}
		})
	}
}

// A client that accepts no encoding still has to get readable bytes, even though
// precompression deleted the original. The gzip copy is decoded on the way out.
func TestIdentityFallbackDecompresses(t *testing.T) {
	h := spaHandler(precompressedFS(t))
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest("GET", "/", nil))

	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want empty for a client that accepts none", got)
	}
	if got := rec.Body.String(); got != "<html>app</html>" {
		t.Errorf("body = %q, want the decompressed index", got)
	}
}

// The SPA fallback has to find index.html through its encodings too, or every
// client-side route breaks once the original is gone.
func TestSpaFallbackFindsEncodedIndex(t *testing.T) {
	h := spaHandler(precompressedFS(t))

	req := httptest.NewRequest("GET", "/project/p1/agent/a1", nil)
	req.Header.Set("Accept-Encoding", "br")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != 200 {
		t.Errorf("status = %d, want 200 for a known client route", rec.Code)
	}
	if got := rec.Body.String(); got != "brotli-index" {
		t.Errorf("body = %q, want the brotli index", got)
	}

	// An unknown path still gets the app, but says it is missing.
	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest("GET", "/nope/nothing/here", nil))
	if rec.Code != 404 {
		t.Errorf("status = %d, want 404 for a path the router does not know", rec.Code)
	}
}

// Source maps carry no extension the mime tables know, and the bytes on disk are
// compressed - so left to sniffing they come back as gzip and DevTools ignores
// them, silently undoing the whole point of shipping maps.
func TestSourceMapContentType(t *testing.T) {
	h := spaHandler(precompressedFS(t))
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest("GET", "/assets/app-abc.js.map", nil))

	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	if rec.Body.String() != `{"version":3}` {
		t.Errorf("body = %q, want the map served as-is", rec.Body.String())
	}
}

// An already-compressed asset is left alone by the build step, so it must still
// be served straight from the FS.
func TestUncompressedAssetStillServed(t *testing.T) {
	h := spaHandler(precompressedFS(t))
	req := httptest.NewRequest("GET", "/icon.png", nil)
	req.Header.Set("Accept-Encoding", "gzip, br")
	rec := httptest.NewRecorder()
	h(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want empty - there is no encoded variant", got)
	}
	if rec.Body.String() != "png-bytes" {
		t.Errorf("body = %q, want the raw png", rec.Body.String())
	}
}

// HEAD must report the encoded length without a body: the browser uses it to
// size the transfer.
func TestHeadSendsLengthWithoutBody(t *testing.T) {
	h := spaHandler(precompressedFS(t))
	req := httptest.NewRequest("HEAD", "/assets/app-abc.js", nil)
	req.Header.Set("Accept-Encoding", "br")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Body.Len() != 0 {
		t.Errorf("HEAD returned %d bytes of body", rec.Body.Len())
	}
	if got := rec.Header().Get("Content-Length"); got != "9" { // len("brotli-js")
		t.Errorf("Content-Length = %q, want 9 (the ENCODED length)", got)
	}
}
