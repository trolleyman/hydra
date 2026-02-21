package main

import (
	"io/fs"
	"log"
	"net/http"

	"github.com/trolleyman/hydra/web"
)

func main() {
	// Extract the "dist" subdirectory from the embedded filesystem
	distFS, err := fs.Sub(web.FrontendAssets, "dist")
	if err != nil {
		log.Fatal(err)
	}

	// Serve the static React files at the root
	http.Handle("/", http.FileServer(http.FS(distFS)))

	// Your API routes go here
	// http.HandleFunc("/api/machines", getMachinesHandler)

	log.Println("Server starting on http://localhost:8080")
	http.ListenAndServe("localhost:8080", nil)
}
