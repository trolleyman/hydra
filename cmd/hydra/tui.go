package main

import (
	"errors"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/tui"
)

func init() {
	rootCmd.AddCommand(tuiCmd)
}

var tuiCmd = &cobra.Command{
	Use:   "tui",
	Short: "Open the interactive agent dashboard",
	RunE:  runTUI,
}

func runTUI(_ *cobra.Command, _ []string) error {
	// Before opening the alternate-screen TUI, check whether a Dockerfile
	// exists and offer to create one if not. We do this in the normal
	// terminal so the question is legible before the TUI takes over.
	if cwd, err := os.Getwd(); err == nil {
		if root, err := git.FindProjectRoot(cwd); err == nil {
			if cfg, err := config.Load(root); err == nil {
				if _, err := config.FindDockerfile(cfg, root, ""); errors.Is(err, config.ErrNoDockerfile) {
					fmt.Println("No agent Dockerfile found for this project.")
					if promptYesNo("Set one up before opening the dashboard?", true) {
						if _, err := ensureDockerfile(cfg, root, ""); err != nil {
							fmt.Printf("Warning: %v\n\n", err)
						}
					} else {
						fmt.Println()
					}
				}
			}
		}
	}

	cli, err := docker.NewClient()
	if err != nil {
		return err
	}
	defer cli.Close()

	m := tui.New(cli)
	p := tea.NewProgram(m, tea.WithAltScreen())
	_, err = p.Run()
	return err
}
