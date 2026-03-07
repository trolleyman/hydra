package cli

import (
	"context"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/heads"
	httppkg "github.com/trolleyman/hydra/internal/http"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
	"github.com/trolleyman/hydra/web"
)

func init() {
	rootCmd.AddCommand(serverCmd)
}

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Run a web server",
	RunE:  runServer,
}

func runServer(_ *cobra.Command, _ []string) error {
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		log.Fatalf("Resolve project root: %v", err)
	}
	worktreesDir := paths.GetWorktreesDirFromProjectRoot(projectRoot)

	log.Printf("Worktrees: %s", worktreesDir)

	dockerClient, err := docker.NewClient()
	if err != nil {
		log.Fatalf("Create docker client: %v", err)
	}

	store, err := db.Open(projectRoot)
	if err != nil {
		log.Fatalf("Open database: %v", err)
	}
	log.Printf("Database: %s", paths.GetDBPathFromProjectRoot(projectRoot))

	pm, err := projects.NewManager()
	if err != nil {
		log.Fatalf("Create projects manager: %v", err)
	}

	// Register the CWD project so it appears in the dropdown.
	defaultProject, err := pm.AddProject(projectRoot)
	if err != nil {
		log.Fatalf("Register default project: %v", err)
	}
	log.Printf("Default project: %s (%s)", defaultProject.Name, defaultProject.ID)

	// Run immediate first cycles of both pollers before accepting HTTP requests.
	ctx := context.Background()
	heads.RunDockerPollerOnce(ctx, dockerClient, store, projectRoot)
	heads.RunJSONStatusPollerOnce(store, projectRoot)

	// Start background pollers.
	go heads.RunDockerPoller(ctx, dockerClient, store, projectRoot)
	go heads.RunJSONStatusPoller(ctx, store, projectRoot)

	server := &httppkg.Server{
		WorktreesDir:      worktreesDir,
		ProjectRoot:       projectRoot,
		DefaultProject:    defaultProject,
		ProjectsManager:   pm,
		DockerClient:      dockerClient,
		DB:                store,
		StartTime:         time.Now(),
		DevRestartEnabled: os.Getenv("HYDRA_DEV_RESTART") == "1",
	}

	// Build the main mux
	mux := http.NewServeMux()

	// Register API routes
	apiHandler := httppkg.NewHandler(server)
	mux.Handle("/api/", apiHandler)
	mux.Handle("/health", apiHandler)

	// WebSocket terminal endpoint
	mux.HandleFunc("/ws/agent/", server.HandleTerminalWS)

	// In API-only mode (e.g. devFast) the frontend is served by the Vite dev server.
	if os.Getenv("HYDRA_API_ONLY") != "1" {
		distFS, err := fs.Sub(web.FrontendAssets, "dist")
		if err != nil {
			log.Fatal(err)
		}
		mux.Handle("/", spaHandler(distFS))
	}

	addr := "localhost:8080"
	if envAddr := os.Getenv("HYDRA_API_ADDR"); envAddr != "" {
		addr = envAddr
	}
	log.Printf("Server starting on http://%s", addr)
	return errtrace.Wrap(http.ListenAndServe(addr, httppkg.LoggingMiddleware(mux)))
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
