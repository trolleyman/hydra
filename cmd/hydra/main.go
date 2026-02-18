package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"

	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/common"
)

// Version is set at build time via -ldflags "-X main.Version=x.y.z".
var Version = "dev"

func main() {
	setupLogging()
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

var rootCmd = &cobra.Command{
	Use:   "hydra",
	Short: "AI agent orchestrator",
	Long: `Hydra is an AI agent orchestrator.
It manages AI coding agents running in isolated Docker containers and git worktrees.`,
	Version: Version,
	// Suppress usage on runtime errors (but show it on arg errors).
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		cmd.SilenceUsage = true
	},
}

func setupLogging() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}

	var logDir string
	if runtime.GOOS == "windows" {
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		logDir = filepath.Join(localAppData, "hydra", "logs")
	} else {
		logDir = filepath.Join(home, ".local", "share", "hydra", "logs")
	}

	rl, err := common.NewRotatingLogger(filepath.Join(logDir, "hydra.log"), 5*1024*1024, 5)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not set up file logging: %v\n", err)
		return
	}

	log.SetOutput(io.MultiWriter(os.Stderr, rl))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
}
