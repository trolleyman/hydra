package main

import (
	"flag"
	"io/fs"
	"log"
	"net/http"

	hydra "github.com/trolleyman/hydra/internal"
	"github.com/trolleyman/hydra/internal/agent"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/web"
)

func main() {
	var dbPath string
	flag.StringVar(&dbPath, "db", "", "Path to SQLite database (default: platform data dir)")
	flag.Parse()

	// Resolve data directory paths
	if dbPath == "" {
		var err error
		dbPath, err = hydra.DBPath()
		if err != nil {
			log.Fatalf("Resolve db path: %v", err)
		}
	}

	worktreesDir, err := hydra.WorktreesDir()
	if err != nil {
		log.Fatalf("Resolve worktrees dir: %v", err)
	}

	log.Printf("Database: %s", dbPath)
	log.Printf("Worktrees: %s", worktreesDir)

	// Open database (runs migrations automatically)
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		log.Fatalf("Open database: %v", err)
	}
	defer sqlDB.Close()

	// Create agent manager
	mgr := agent.NewManager(sqlDB, worktreesDir)

	// Create API server
	server := &api.Server{
		DB:           sqlDB,
		Manager:      mgr,
		WorktreesDir: worktreesDir,
	}

	// Build the main mux
	mux := http.NewServeMux()

	// Register API routes
	apiHandler := api.NewHandler(server)
	mux.Handle("/api/", apiHandler)
	mux.Handle("/health", apiHandler)

	// Serve the static React SPA
	distFS, err := fs.Sub(web.FrontendAssets, "dist")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", spaHandler(distFS))

	addr := "localhost:8080"
	log.Printf("Server starting on http://%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("ListenAndServe: %v", err)
	}
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

func trimSlash(s string) string {
	if len(s) > 0 && s[0] == '/' {
		return s[1:]
	}
	return s
}
