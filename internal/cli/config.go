package cli

import (
	"fmt"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/paths"
)

func init() {
	rootCmd.AddCommand(configCmd)
	configCmd.AddCommand(configInitCmd)
}

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage project configuration",
}

var configInitCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize project configuration with a documented settings template",
	Long: `Write a self-documenting .hydra/config.toml: every setting (writable
paths, masked credential locations, network policy, pre-prompts, artifacts) is
listed commented-out with its built-in default and an explanation, ready to be
uncommented and customized. An existing config is migrated/updated in place,
preserving your own comments and any [[artifacts]] blocks.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectRoot, err := paths.GetProjectRootFromCwd()
		if err != nil {
			return errtrace.Wrap(err)
		}

		// An empty config renders the fully-documented, all-commented template.
		// The baked-in sandbox defaults already apply, so there is nothing to
		// activate here — the file exists to document and to be customized.
		path := config.GetProjectConfigPath(projectRoot)
		if err := config.SaveToFile(path, config.Config{}); err != nil {
			return errtrace.Wrap(err)
		}

		fmt.Printf("Wrote documented config template to %s\n", path)
		return nil
	},
}
