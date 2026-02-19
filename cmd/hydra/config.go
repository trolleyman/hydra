package main

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
)

func init() {
	configCmd.AddCommand(configShowCmd)
	rootCmd.AddCommand(configCmd)

	configShowCmd.Flags().BoolVar(&configShowFlags.source, "source", false, "Show the source config file for each value")
}

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Read and write Hydra configuration",
}

var configShowFlags struct {
	source bool
}

var configShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show all configuration values",
	RunE: func(cmd *cobra.Command, args []string) error {
		projectRoot, err := git.FindProjectRootFromCwd()
		if err != nil {
			return err
		}
		config, err := config.Load(projectRoot)
		if err != nil {
			return err
		}
		printConfig("Prompt", config.Prompt)
		printConfig("Agent", config.Agent)
		fmt.Printf("Agents:\n")
		if len(config.Agents) == 0 {
			fmt.Println("  <none>")
		} else {
			for name, agent := range config.Agents {
				printConfig(fmt.Sprintf("  %q", name), &agent)
			}
		}
		return nil
	},
}

func printConfig[T any](name string, value *config.ValueSource[T]) {
	if value == nil {
		fmt.Printf("%s = <unset>\n", name)
		return
	}
	fmt.Printf("%s = %q", name, truncateValue(fmt.Sprintf("%v", value.Value)))
	if configShowFlags.source && value.Source != nil {
		fmt.Printf(" (from %v - %v)", value.Source.Label, value.Source.Directory)
	}
	fmt.Println()
}

// truncateValue makes a value safe for single-line table display.
func truncateValue(s string) string {
	// Replace newlines with a visible marker so the table stays single-line.
	s = strings.ReplaceAll(s, "\n", "↵")
	if len(s) > 60 {
		s = s[:60] + "…"
	}
	return s
}
