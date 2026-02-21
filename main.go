package main

import (
	"io/fs"
	"log"
	"net/http"
	"strings"

	"github.com/trolleyman/hydra/web"
)

func spaHandler(fsys fs.FS) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(fsys))

	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		cleanPath := strings.TrimPrefix(path, "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		// Serve file if it exists
		_, err := fs.Stat(fsys, cleanPath)
		if err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}

		// File does not exist - send index.html unconditionally
		indexContent, err := fs.ReadFile(fsys, "index.html")
		if err != nil {
			log.Printf("Error reading index.html: %v", err)
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/html")

		if web.RoutesRegex.MatchString(cleanPath) {
			// Return 200 if it's a valid React page
			w.WriteHeader(http.StatusOK)
		} else {
			// Return a true 404 HTTP status code, but still send index.html
			// so React can render the <NotFound /> component.
			w.WriteHeader(http.StatusNotFound)
		}

		w.Write(indexContent)
	}
}

func main() {
	// Extract the "dist" subdirectory from the embedded filesystem
	distFS, err := fs.Sub(web.FrontendAssets, "dist")
	if err != nil {
		log.Fatal(err)
	}

	// Serve the static React files at the root
	http.Handle("/", spaHandler(distFS))

	// TODO: API routes here
	// http.HandleFunc("/api/todo", getTodoHandler)

	log.Println("Server starting on http://localhost:8080")
	http.ListenAndServe("localhost:8080", nil)
}
