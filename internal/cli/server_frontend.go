//go:build !hydra_no_frontend

package cli

import (
	"io/fs"
	"log"
	"net/http"

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

		if web.RoutesRegex.MatchString(path) {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusNotFound)
		}

		w.Write(indexContent)
	}
}
