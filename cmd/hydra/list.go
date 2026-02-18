package main

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/tui"
)

func init() {
	rootCmd.AddCommand(listCmd)
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List all running AI agents (interactive TUI)",
	RunE:  runTUI,
}

func runTUI(_ *cobra.Command, _ []string) error {
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

