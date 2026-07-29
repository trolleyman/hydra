//go:build !hydra_no_frontend

package cli

import (
	"compress/gzip"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/trolleyman/hydra/web"
)

// registerFrontend mounts the embedded React SPA on the root of mux.
func registerFrontend(mux *http.ServeMux) {
	distFS, err := fs.Sub(web.FrontendAssets, "dist")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", spaHandler(distFS))
}

// encodings are the precompressed variants web/scripts/precompress.ts writes,
// best first. That script REPLACES each original with these rather than sitting
// beside it, which is the point: dist is compiled into the binary, so an
// uncompressed copy would be paid for on disk forever to serve a client that
// does not exist.
var encodings = []struct{ name, suffix string }{
	{"br", ".br"},
	{"gzip", ".gz"},
}

func spaHandler(fsys fs.FS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cleanPath := trimSlash(r.URL.Path)
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		if serveAsset(w, r, fsys, cleanPath, http.StatusOK) {
			return
		}

		// No such file - hand back index.html so the client router can take over.
		// A path the router knows is a page (200); anything else really is missing
		// (404), but still gets the app so it can say so in its own UI.
		status := http.StatusNotFound
		if web.RoutesRegex.MatchString(r.URL.Path) {
			status = http.StatusOK
		}
		if serveAsset(w, r, fsys, "index.html", status) {
			return
		}
		log.Printf("frontend: index.html is missing from the embedded assets")
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
	}
}

// serveAsset writes name from fsys, preferring a precompressed variant the client
// said it can read. Reports whether it found anything.
//
// Content-Type comes from name's own extension, never the variant's: the file on
// disk is `index-abc.js.br`, and `.br` means nothing to a browser. Content-Length
// is the encoded length, and no Range support is advertised - a range over a
// content-encoded body describes bytes of a representation the client did not ask
// for, and nothing here needs one.
func serveAsset(w http.ResponseWriter, r *http.Request, fsys fs.FS, name string, status int) bool {
	// Headers common to every branch below. Vary is set even when we end up
	// serving identity, so a shared cache never hands a brotli body to a client
	// that cannot read it.
	setHeaders := func() {
		setFrontendCacheHeader(w, name)
		w.Header().Set("Content-Type", contentTypeFor(name))
		w.Header().Add("Vary", "Accept-Encoding")
	}

	// Best encoding the client accepts that we actually have.
	for _, enc := range encodings {
		if !acceptsEncoding(r, enc.name) {
			continue
		}
		data, err := fs.ReadFile(fsys, name+enc.suffix)
		if err != nil {
			continue
		}
		setHeaders()
		w.Header().Set("Content-Encoding", enc.name)
		writeBody(w, r, data, status)
		return true
	}

	// The client wants it unencoded. Usually that just means reading it off the
	// embedded FS - small files are left uncompressed by the build step.
	if data, err := fs.ReadFile(fsys, name); err == nil {
		setHeaders()
		writeBody(w, r, data, status)
		return true
	}

	// Otherwise precompression removed the original, so decode one back. gzip
	// rather than brotli because the standard library can do it, which keeps this
	// fallback free of a new dependency. Cold path: every browser sends gzip, so
	// this is for curl and the occasional health checker.
	f, err := fsys.Open(name + ".gz")
	if err != nil {
		return false
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		log.Printf("frontend: %s.gz is corrupt: %v", name, err)
		return false
	}
	defer zr.Close()

	setHeaders()
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		if _, err := io.Copy(w, zr); err != nil && !isClientGone(err) {
			log.Printf("frontend: decompressing %s: %v", name, err)
		}
	}
	return true
}

func writeBody(w http.ResponseWriter, r *http.Request, data []byte, status int) {
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := w.Write(data); err != nil && !isClientGone(err) {
		log.Printf("frontend: writing response: %v", err)
	}
}

// isClientGone reports whether an error is just the browser hanging up - a
// cancelled fetch, a navigation mid-download - rather than anything wrong here.
func isClientGone(err error) bool {
	s := err.Error()
	return strings.Contains(s, "broken pipe") ||
		strings.Contains(s, "connection reset") ||
		strings.Contains(s, "client disconnected")
}

// acceptsEncoding reports whether the client offered enc. A bare token match is
// enough: no mainstream client sends `br;q=0` while also being one we would want
// to serve brotli to.
func acceptsEncoding(r *http.Request, enc string) bool {
	for candidate := range strings.SplitSeq(r.Header.Get("Accept-Encoding"), ",") {
		name, _, _ := strings.Cut(strings.TrimSpace(candidate), ";")
		if strings.EqualFold(name, enc) {
			return true
		}
	}
	return false
}

// contentTypeFor maps a logical asset name to its media type. `.map` is absent
// from the system mime tables, and left to sniffing it would come back as gzip -
// the bytes we hold are compressed.
func contentTypeFor(name string) string {
	if path.Ext(name) == ".map" {
		return "application/json"
	}
	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// setFrontendCacheHeader sets the cache policy for an embedded frontend file.
// Embedded files carry no modtime, so no Last-Modified or ETag is emitted -
// without an explicit Cache-Control the browser falls back to HEURISTIC caching
// and can keep serving a stale index.html (and through it the whole old app)
// after a rebuild+restart. Policy: content-hashed Vite bundles (assets/*) are
// immutable and cacheable forever; everything else (index.html, icons, manifest -
// stable names, replaceable content) must be revalidated, and with no validators
// no-cache means a re-fetch, which is fine at these sizes.
func setFrontendCacheHeader(w http.ResponseWriter, cleanPath string) {
	if strings.HasPrefix(cleanPath, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
}
