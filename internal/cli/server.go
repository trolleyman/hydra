package cli

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/heads"
	httppkg "github.com/trolleyman/hydra/internal/http"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
)

var simulationMode bool

func init() {
	serverCmd.Flags().BoolVar(&simulationMode, "simulation", false, "Run in simulation mode with mock data")
	rootCmd.AddCommand(serverCmd)
}

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Run a web server",
	RunE:  runServer,
}

func runServer(_ *cobra.Command, _ []string) error {
	if simulationMode {
		return errtrace.Wrap(runSimulationServer())
	}

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

	ctx := context.Background()

	server := &httppkg.Server{
		WorktreesDir:    worktreesDir,
		ProjectRoot:     projectRoot,
		DefaultProject:  defaultProject,
		ProjectsManager: pm,
		DockerClient:    dockerClient,
		DB:              store,
		StartTime:       time.Now(),
		Development:     os.Getenv("HYDRA_DEV_RESTART") == "1",
	}

	// Run immediate first cycles of both pollers before accepting HTTP requests.
	heads.RunDockerPollerOnce(ctx, dockerClient, store, projectRoot, server.SetDockerError)
	heads.RunJSONStatusPollerOnce(store, projectRoot)

	// Start background pollers.
	go heads.RunDockerPoller(ctx, dockerClient, store, projectRoot, server.SetDockerError)
	go heads.RunJSONStatusPoller(ctx, store, projectRoot)

	// Build the main mux
	mux := http.NewServeMux()

	// Register API routes
	apiHandler := httppkg.NewHandler(server)
	mux.Handle("/api/", apiHandler)
	mux.Handle("/health", apiHandler)

	// WebSocket terminal endpoint
	mux.HandleFunc("/ws/agent/", server.HandleTerminalWS)

	// API routes for well-known and specific paths
	mux.Handle("/.well-known/", apiHandler)

	registerFrontend(mux)

	addr := "localhost:8080"
	if envAddr := os.Getenv("HYDRA_API_ADDR"); envAddr != "" {
		addr = envAddr
	}
	log.Printf("Server starting on http://%s", addr)
	return errtrace.Wrap(http.ListenAndServe(addr, httppkg.LoggingMiddleware(mux)))
}

func runSimulationServer() error {
	log.Printf("Starting Hydra in SIMULATION mode")

	server := &httppkg.SimulationServer{
		StartTime: time.Now(),
	}

	mux := http.NewServeMux()

	// Register API routes (into mux)
	api.HandlerFromMux(server, mux)

	// Mock WebSocket terminal endpoint
	mux.HandleFunc("/ws/agent/", server.HandleTerminalWS)

	registerFrontend(mux)

	addr := "localhost:8080"
	if envAddr := os.Getenv("HYDRA_API_ADDR"); envAddr != "" {
		addr = envAddr
	}
	log.Printf("Simulation Server starting on http://%s", addr)
	return errtrace.Wrap(http.ListenAndServe(addr, httppkg.LoggingMiddleware(mux)))
}

func trimSlash(s string) string {
	if len(s) > 0 && s[0] == '/' {
		return s[1:]
	}
	return s
}
