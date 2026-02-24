package cli

import (
	"io/fs"
	"log"
	"net/http"
	"time"

	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/docker"
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

	server := &httppkg.Server{
		WorktreesDir:    worktreesDir,
		ProjectRoot:     projectRoot,
		DefaultProject:  defaultProject,
		ProjectsManager: pm,
		DockerClient:    dockerClient,
		StartTime:       time.Now(),
	}

	// Build the main mux
	mux := http.NewServeMux()

	// Register API routes
	apiHandler := httppkg.NewHandler(server)
	mux.Handle("/api/", apiHandler)
	mux.Handle("/health", apiHandler)

	// WebSocket terminal endpoint
	mux.HandleFunc("/ws/agent/", server.HandleTerminalWS)

	// Serve the static React SPA
	distFS, err := fs.Sub(web.FrontendAssets, "dist")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("/", spaHandler(distFS))

	addr := "localhost:8080"
	log.Printf("Server starting on http://%s", addr)
	return http.ListenAndServe(addr, httppkg.LoggingMiddleware(mux))
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
