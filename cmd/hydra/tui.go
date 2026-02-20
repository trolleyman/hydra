package main

import (
	"braces.dev/errtrace"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/docker"
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
	cli, err := docker.NewClient()
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer cli.Close()

	m := tui.New(cli)
	p := tea.NewProgram(m, tea.WithAltScreen())
	_, err = p.Run()
	return errtrace.Wrap(err)
}
