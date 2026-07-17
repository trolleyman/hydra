//go:build !hydra_no_frontend

package cli

import (
	"io/fs"
	"log"
	"net/http"
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

func spaHandler(fsys fs.FS) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(fsys))

	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		cleanPath := trimSlash(path)
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		// Serve file if it exists in dist/
		_, err := fs.Stat(fsys, cleanPath)
		if err == nil {
			setFrontendCacheHeader(w, cleanPath)
			fileServer.ServeHTTP(w, r)
			return
		}

		// File does not exist - return index.html for client-side routing
		indexContent, err := fs.ReadFile(fsys, "index.html")
		if err != nil {
			log.Printf("Error reading index.html: %v", err)
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/html")
		setFrontendCacheHeader(w, "index.html")

		if web.RoutesRegex.MatchString(path) {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusNotFound)
		}

		w.Write(indexContent)
	}
}

// setFrontendCacheHeader sets the cache policy for an embedded frontend file.
// Embedded files carry no modtime, so http.FileServer emits neither
// Last-Modified nor an ETag - without an explicit Cache-Control the browser
// falls back to HEURISTIC caching and can keep serving a stale index.html
// (and through it the whole old app) after a rebuild+restart. Policy:
// content-hashed Vite bundles (assets/*) are immutable and cacheable forever;
// everything else (index.html, icons, manifest - stable names, replaceable
// content) must be revalidated, and with no validators no-cache means a
// re-fetch, which is fine at these sizes.
func setFrontendCacheHeader(w http.ResponseWriter, cleanPath string) {
	if strings.HasPrefix(cleanPath, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
}
