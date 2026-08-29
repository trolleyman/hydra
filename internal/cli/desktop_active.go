package cli

import (
	"encoding/json"
	"os"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/daemon"
	"github.com/trolleyman/hydra/internal/paths"
)

var desktopActiveProject string

func init() {
	desktopActiveCmd.Flags().StringVar(&desktopActiveProject, "project", "", "project root")
	rootCmd.AddCommand(desktopActiveCmd)
}

var desktopActiveCmd = &cobra.Command{
	Use:    "__desktop-active",
	Hidden: true,
	Args:   cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		projectRoot := desktopActiveProject
		if projectRoot == "" {
			var err error
			projectRoot, err = paths.GetProjectRootFromCwd()
			if err != nil {
				return errtrace.Wrap(err)
			}
		}
		client, err := daemon.ConnectDesktop(cmd.Context(), projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}
		projects, err := client.ListProjects(cmd.Context())
		if err != nil {
			return errtrace.Wrap(err)
		}
		active := false
		for _, project := range projects {
			client.SelectProjectID(project.Id)
			agents, err := client.ListAgents(cmd.Context())
			if err != nil {
				return errtrace.Wrap(err)
			}
			for _, agent := range agents {
				if agent.SessionStatus == "running" {
					active = true
					break
				}
			}
			if active {
				break
			}
		}
		return errtrace.Wrap(json.NewEncoder(os.Stdout).Encode(struct {
			Active bool `json:"active"`
		}{Active: active}))
	},
}
