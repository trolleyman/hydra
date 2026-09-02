package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/daemon"
	"github.com/trolleyman/hydra/internal/desktopcontract"
)

var desktopConnectProject string

func init() {
	desktopConnectCmd.Flags().StringVar(&desktopConnectProject, "project", "", "project root")
	rootCmd.AddCommand(desktopConnectCmd)
}

var desktopConnectCmd = &cobra.Command{
	Use:    "__desktop-connect",
	Hidden: true,
	Args:   cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		projectRoot, err := desktopProjectRoot(desktopConnectProject)
		if err != nil {
			return errtrace.Wrap(err)
		}
		ctx := cmd.Context()
		client, err := daemon.ConnectDesktop(ctx, projectRoot)
		if err != nil {
			return errtrace.Wrap(err)
		}
		webURL, err := daemon.ReadWebURL(projectRoot)
		if err != nil {
			return errtrace.Wrap(fmt.Errorf("read desktop web endpoint: %w", err))
		}
		bootstrap, err := client.IssueDesktopBootstrap(ctx)
		if err != nil {
			return errtrace.Wrap(err)
		}
		status, err := client.Status(ctx)
		if err != nil {
			return errtrace.Wrap(err)
		}
		if status.DesktopProtocol == nil || *status.DesktopProtocol != desktopcontract.Protocol {
			got := 0
			if status.DesktopProtocol != nil {
				got = *status.DesktopProtocol
			}
			return errtrace.Wrap(fmt.Errorf("desktop backend protocol %d is incompatible with shell protocol %d", got, desktopcontract.Protocol))
		}
		return errtrace.Wrap(json.NewEncoder(os.Stdout).Encode(struct {
			Protocol        int     `json:"protocol"`
			URL             string  `json:"url"`
			BootstrapToken  string  `json:"bootstrap_token"`
			ExpiresAt       string  `json:"expires_at"`
			Version         *string `json:"version"`
			ProjectRoot     *string `json:"project_root"`
			DefaultProject  *string `json:"default_project_id"`
			BuildID         *string `json:"build_id"`
			SelectedProject string  `json:"selected_project_id"`
		}{
			Protocol:        desktopcontract.Protocol,
			URL:             webURL,
			BootstrapToken:  bootstrap.Token,
			ExpiresAt:       time.Now().Add(time.Duration(bootstrap.ExpiresInSeconds) * time.Second).UTC().Format(time.RFC3339),
			Version:         status.Version,
			ProjectRoot:     status.ProjectRoot,
			DefaultProject:  status.DefaultProjectId,
			BuildID:         status.BuildId,
			SelectedProject: client.ProjectID,
		}))
	},
}
