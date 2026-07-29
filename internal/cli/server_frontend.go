//go:build !hydra_no_frontend

package cli

import (
	"compress/gzip"
	"encoding/json"
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

func init() {
	// Source maps have no entry in the system mime tables, and left to content
	// sniffing they come back as gzip - the bytes we hold are compressed - which
	// makes DevTools quietly ignore them, undoing the whole point of shipping
	// them. Register it once rather than special-casing it per request.
	_ = mime.AddExtensionType(".map", "application/json")
}

// encodedManifest is the file web/scripts/precompress.ts writes listing every
// asset whose original it replaced with encoded variants, and which encodings it
// produced. See assetIndex.
const encodedManifest = ".encoded.json"

// encodingSuffix maps a Content-Encoding token to the file suffix the build step
// writes for it.
var encodingSuffix = map[string]string{"br": ".br", "gzip": ".gz"}

// assetIndex is what the build step recorded, so serving is a lookup rather than
// a guess: for a given path we know whether the original still exists and which
// encodings sit beside it. Absent from the map means "still on disk, unencoded"
// (small files and already-compressed types are left alone).
//
// An empty index is a valid state, not an error: a `vite build` run without the
// precompress step leaves a plain dist, and then every lookup misses and every
// asset is read directly - which is exactly right.
type assetIndex map[string][]string

func loadAssetIndex(fsys fs.FS) assetIndex {
	data, err := fs.ReadFile(fsys, encodedManifest)
	if err != nil {
		return assetIndex{}
	}
	var idx assetIndex
	if err := json.Unmarshal(data, &idx); err != nil {
		log.Printf("frontend: %s is unreadable (%v); serving assets unencoded", encodedManifest, err)
		return assetIndex{}
	}
	return idx
}

// registerFrontend mounts the embedded React SPA on the root of mux.
func registerFrontend(mux *http.ServeMux) {
	distFS, err := fs.Sub(web.FrontendAssets, "dist")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", spaHandler(distFS))
}

func spaHandler(fsys fs.FS) http.HandlerFunc {
	index := loadAssetIndex(fsys)

	return func(w http.ResponseWriter, r *http.Request) {
		cleanPath := trimSlash(r.URL.Path)
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		if serveAsset(w, r, fsys, index, cleanPath, http.StatusOK) {
			return
		}

		// No such file - hand back index.html so the client router can take over.
		// A path the router knows is a page (200); anything else really is missing
		// (404), but still gets the app so it can say so in its own UI.
		status := http.StatusNotFound
		if web.RoutesRegex.MatchString(r.URL.Path) {
			status = http.StatusOK
		}
		if serveAsset(w, r, fsys, index, "index.html", status) {
			return
		}
		log.Printf("frontend: index.html is missing from the embedded assets")
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
	}
}

// serveAsset writes name from fsys, preferring a precompressed variant the client
// said it can read. Reports whether it found anything.
//
// Which variants exist comes from the build manifest, not from trying paths until
// one opens. Content-Type comes from the LOGICAL name, never the variant's: the
// file on disk is `index-abc.js.br`, and `.br` means nothing to a browser.
// Content-Length is the encoded length, and no Range support is advertised - a
// range over a content-encoded body describes bytes of a representation the
// client did not ask for, and nothing here needs one.
func serveAsset(w http.ResponseWriter, r *http.Request, fsys fs.FS, index assetIndex, name string, status int) bool {
	available, encoded := index[name]

	// Headers common to every branch below. Vary is set even when we serve
	// identity, so a shared cache never hands a brotli body to a client that
	// cannot read it.
	setHeaders := func() {
		setFrontendCacheHeader(w, name)
		w.Header().Set("Content-Type", contentTypeFor(name))
		w.Header().Add("Vary", "Accept-Encoding")
	}

	// Best encoding the build produced that this client accepts.
	for _, enc := range available {
		if !acceptsEncoding(r, enc) {
			continue
		}
		data, err := fs.ReadFile(fsys, name+encodingSuffix[enc])
		if err != nil {
			log.Printf("frontend: %s is in %s as %q but missing from the bundle: %v", name, encodedManifest, enc, err)
			continue
		}
		setHeaders()
		w.Header().Set("Content-Encoding", enc)
		writeBody(w, r, data, status)
		return true
	}

	// Not encoded at all - small files and already-compressed types are left as
	// they were built, so read the original.
	if !encoded {
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			return false
		}
		setHeaders()
		writeBody(w, r, data, status)
		return true
	}

	// Encoded, but this client accepts none of the encodings, and the original
	// was removed - so decode one back. gzip rather than brotli because the
	// standard library can do it, which keeps this free of a new dependency. Cold
	// path: every browser sends gzip, so it is for curl and health checkers.
	f, err := fsys.Open(name + encodingSuffix["gzip"])
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

// contentTypeFor maps a logical asset name to its media type (see the init above
// for `.map`). Never sniffed: for an encoded asset the bytes in hand are
// compressed, so sniffing would confidently answer "gzip" for everything.
func contentTypeFor(name string) string {
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
