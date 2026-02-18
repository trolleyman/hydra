package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
)

func init() {
	configCmd.AddCommand(configGetCmd)
	configCmd.AddCommand(configSetCmd)
	configCmd.AddCommand(configListCmd)
	configCmd.AddCommand(configInitCmd)
	rootCmd.AddCommand(configCmd)

	configSetCmd.Flags().BoolVar(&configSetFlags.system, "system", false, "Write to system config (/etc/hydra/config.toml)")
	configSetCmd.Flags().BoolVar(&configSetFlags.global, "global", false, "Write to global user config (~/.config/hydra/config.toml)")
	configSetCmd.Flags().BoolVar(&configSetFlags.user, "user", false, "Alias for --global")

	configListCmd.Flags().BoolVar(&configListFlags.source, "source", false, "Show the source config file for each value")
}

// ---------------------------------------------------------------------------
// configCmd
// ---------------------------------------------------------------------------

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Read and write Hydra configuration",
}

// ---------------------------------------------------------------------------
// config get
// ---------------------------------------------------------------------------

var configGetCmd = &cobra.Command{
	Use:   "get <key>",
	Short: "Get the effective value for a configuration key",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		v, err := loadMergedViper()
		if err != nil {
			return err
		}
		key := args[0]
		if !v.IsSet(key) {
			return fmt.Errorf("key %q is not set", key)
		}
		fmt.Println(v.Get(key))
		return nil
	},
}

// ---------------------------------------------------------------------------
// config set
// ---------------------------------------------------------------------------

var configSetFlags struct {
	system bool
	global bool
	user   bool // alias for --global
}

var configSetCmd = &cobra.Command{
	Use:   "set <key> <value>",
	Short: "Set a configuration value",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		// Validate mutual exclusivity manually
		exclusive := 0
		if configSetFlags.system {
			exclusive++
		}
		if configSetFlags.global || configSetFlags.user {
			exclusive++
		}
		if exclusive > 1 {
			return fmt.Errorf("--system and --global/--user are mutually exclusive")
		}

		key, value := args[0], args[1]

		configPath, err := targetConfigPath(configSetFlags.system, configSetFlags.global || configSetFlags.user)
		if err != nil {
			return err
		}

		if err := writeConfigValue(configPath, key, value); err != nil {
			return err
		}

		fmt.Printf("set %s = %s  (%s)\n", key, value, configPath)
		return nil
	},
}

// ---------------------------------------------------------------------------
// config list
// ---------------------------------------------------------------------------

var configListFlags struct {
	source bool
}

var configListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all configuration values",
	RunE: func(cmd *cobra.Command, args []string) error {
		type entry struct {
			value  string
			source string
		}

		// Iterate system → global → project so that higher-priority sources
		// overwrite lower-priority ones for the same key.
		merged := map[string]entry{}
		for _, item := range allConfigSources() {
			v := viper.New()
			v.SetConfigFile(item.Path)
			v.SetConfigType("toml")
			if err := v.ReadInConfig(); err != nil {
				continue // file absent or unreadable — skip
			}
			for _, key := range v.AllKeys() {
				merged[key] = entry{
					value:  fmt.Sprintf("%v", v.Get(key)),
					source: item.Label,
				}
			}
		}

		if len(merged) == 0 {
			fmt.Println("No configuration values set.")
			return nil
		}

		keys := make([]string, 0, len(merged))
		for k := range merged {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		if configListFlags.source {
			fmt.Fprintln(w, "KEY\tVALUE\tSOURCE")
		} else {
			fmt.Fprintln(w, "KEY\tVALUE")
		}
		for _, k := range keys {
			e := merged[k]
			display := truncateValue(e.value)
			if configListFlags.source {
				fmt.Fprintf(w, "%s\t%s\t%s\n", k, display, e.source)
			} else {
				fmt.Fprintf(w, "%s\t%s\n", k, display)
			}
		}
		return w.Flush()
	},
}

// ---------------------------------------------------------------------------
// config init
// ---------------------------------------------------------------------------

var configInitCmd = &cobra.Command{
	Use:   "init [claude|gemini]",
	Short: "Create a Dockerfile template for the specified AI agent",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		var agent config.AgentType
		if len(args) == 1 {
			switch strings.ToLower(args[0]) {
			case "claude":
				agent = config.AgentClaude
			case "gemini":
				agent = config.AgentGemini
			default:
				return fmt.Errorf("unknown agent %q; valid options: claude, gemini", args[0])
			}
		} else {
			var err error
			agent, err = promptAgentChoice()
			if err != nil {
				return err
			}
		}

		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		root, err := git.FindProjectRoot(cwd)
		if err != nil {
			return err
		}

		dockerfilePath := config.DefaultDockerfilePath(root)

		if _, err := os.Stat(dockerfilePath); err == nil {
			if !promptYesNo(fmt.Sprintf("Dockerfile already exists at %s. Overwrite?", dockerfilePath), false) {
				return nil
			}
		}

		if err := config.WriteDockerfile(agent, dockerfilePath); err != nil {
			return err
		}

		fmt.Printf("Created %s Dockerfile at %s\n", agent, dockerfilePath)
		fmt.Println("Edit it to customise the agent environment, then run:")
		fmt.Println("  hydra spawn <prompt>")
		return nil
	},
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// projectRoot returns the git project root from CWD, or "" if not in a repo.
func projectRoot() string {
	cwd, err := os.Getwd()
	if err != nil {
		return ""
	}
	root, err := git.FindProjectRoot(cwd)
	if err != nil {
		return ""
	}
	return root
}

// allConfigSources returns config file locations in ascending priority order
// (system < global < project). The project entry is omitted when not in a git repo.
func allConfigSources() []config.Source {
	return config.Sources(projectRoot())
}

// loadMergedViper builds a viper instance with all config sources merged,
// higher-priority sources taking precedence.
func loadMergedViper() (*viper.Viper, error) {
	v := viper.New()
	v.SetConfigType("toml")

	for _, src := range allConfigSources() {
		if _, err := os.Stat(src.Path); err != nil {
			continue
		}
		sub := viper.New()
		sub.SetConfigFile(src.Path)
		sub.SetConfigType("toml")
		if err := sub.ReadInConfig(); err != nil {
			continue
		}
		if err := v.MergeConfigMap(sub.AllSettings()); err != nil {
			return nil, fmt.Errorf("merge %s: %w", src.Label, err)
		}
	}
	return v, nil
}

// targetConfigPath returns the config file path to write to based on flags.
func targetConfigPath(system, global bool) (string, error) {
	if system {
		return "/etc/hydra/config.toml", nil
	}
	if global {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("home directory: %w", err)
		}
		return filepath.Join(home, ".config", "hydra", "config.toml"), nil
	}
	// Default: project config
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("working directory: %w", err)
	}
	root, err := git.FindProjectRoot(cwd)
	if err != nil {
		return "", fmt.Errorf("not in a git repository; use --global or --system to target a non-project config")
	}
	return filepath.Join(root, ".hydra", "config.toml"), nil
}

// writeConfigValue reads the target config file, sets key=value, and writes it back.
func writeConfigValue(configPath, key, value string) error {
	if err := os.MkdirAll(filepath.Dir(configPath), 0755); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}

	v := viper.New()
	v.SetConfigFile(configPath)
	v.SetConfigType("toml")
	// Read existing config; ignore "file not found" — we'll create it.
	_ = v.ReadInConfig()

	v.Set(key, value)
	return v.WriteConfigAs(configPath)
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
