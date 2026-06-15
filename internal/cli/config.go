package cli

import (
	"fmt"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
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
	Short: "Initialize project configuration with the default sandbox policy",
	Long: `Write the default sandbox policy (writable paths, masked credential
locations, network policy) to .hydra/config.toml, which can then be edited to
customize what agents in this project can read, write, and reach.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectRoot, err := paths.GetProjectRootFromCwd()
		if err != nil {
			return errtrace.Wrap(err)
		}

		def := sandbox.Defaults()
		enabled := true
		cfg := config.Config{
			Defaults: config.AgentConfig{
				Sandbox: &config.SandboxConfig{
					WritablePaths: def.WritablePaths,
					MaskedPaths:   def.MaskedPaths,
					RestoreRO:     def.RestoreRO,
					Network:       &config.NetworkConfig{Enabled: &enabled},
				},
			},
		}

		path := config.GetProjectConfigPath(projectRoot)
		if err := config.SaveToFile(path, cfg); err != nil {
			return errtrace.Wrap(err)
		}

		fmt.Printf("Wrote default sandbox config to %s\n", path)
		return nil
	},
}
