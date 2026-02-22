package main

import (
	"fmt"
	"os"

	"braces.dev/errtrace"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"
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
	cwd, err := os.Getwd()
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("get working directory: %w", err))
	}
	projectRoot, err := git.FindProjectRoot(cwd)
	if err != nil {
		return errtrace.Wrap(err)
	}

	cli, err := docker.NewClient()
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer cli.Close()

	m := tui.New(cli, projectRoot)
	p := tea.NewProgram(m, tea.WithAltScreen())
	_, err = p.Run()
	return errtrace.Wrap(err)
}
