package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/common"
)

var (
	// Version is set at build time
	Version = "dev"
)

func init() {
	rootCmd.AddCommand(listCmd)
}

func main() {
	setupLogging()
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

var rootCmd = &cobra.Command{
	Use:   "hydra",
	Short: "AI orchestrator",
	Long: `Hyrda is an AI orchestrator.
It provides management of AI agents running in background Docker containers.`,
	Version: Version,
	// Silence usage after args validation passes (show usage for arg errors, not runtime errors)
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		cmd.SilenceUsage = true
	},
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List all AI agents",
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Println("TEST")
		return nil
	},
}

func setupLogging() {
	var logDir string
	home, err := os.UserHomeDir()
	if err != nil {
		return // Can't find home dir, skip file logging
	}

	// Determine log directory based on OS
	if os.Getenv("OS") == "Windows_NT" {
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		logDir = filepath.Join(localAppData, "ottoman", "logs")
	} else {
		logDir = filepath.Join(home, ".local", "share", "ottoman", "logs")
	}

	logPath := filepath.Join(logDir, "ottoman.log")
	rl, err := common.NewRotatingLogger(logPath, 5*1024*1024, 5) // 5MB, 5 backups
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to setup file logging: %v\n", err)
		return
	}

	// Log to both stderr and file
	log.SetOutput(io.MultiWriter(os.Stderr, rl))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
}
