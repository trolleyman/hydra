package cli

import (
	"braces.dev/errtrace"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/session"
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
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		return errtrace.Wrap(err)
	}

	store, err := db.Open(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}

	reg := session.NewRegistry()
	m := tui.New(reg, store, projectRoot)
	p := tea.NewProgram(m, tea.WithAltScreen())
	_, err = p.Run()
	return errtrace.Wrap(err)
}
