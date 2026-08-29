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
	"github.com/trolleyman/hydra/internal/paths"
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
		projectRoot := desktopConnectProject
		if projectRoot == "" {
			var err error
			projectRoot, err = paths.GetProjectRootFromCwd()
			if err != nil {
				return errtrace.Wrap(err)
			}
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
		return errtrace.Wrap(json.NewEncoder(os.Stdout).Encode(struct {
			Protocol       int    `json:"protocol"`
			URL            string `json:"url"`
			BootstrapToken string `json:"bootstrap_token"`
			ExpiresAt      string `json:"expires_at"`
		}{
			Protocol:       desktopcontract.Protocol,
			URL:            webURL,
			BootstrapToken: bootstrap.Token,
			ExpiresAt:      time.Now().Add(time.Duration(bootstrap.ExpiresInSeconds) * time.Second).UTC().Format(time.RFC3339),
		}))
	},
}
