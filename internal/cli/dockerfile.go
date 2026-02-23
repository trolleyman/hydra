package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/paths"
)

func init() {
	rootCmd.AddCommand(dockerfileCmd)
}

var dockerfileCmd = &cobra.Command{
	Use:   "dockerfile [agent-type...]",
	Short: "Write default Dockerfiles to the project for customisation",
	Long: `Write the built-in Dockerfile(s) for the given agent type(s) into
.hydra/dockerfiles/<type>/ so they can be edited and referenced from
.hydra/config.toml.

Agent types: claude, gemini (default: all)

After running this command you can reference the generated files in
.hydra/config.toml:

  [agents.claude]
  dockerfile = ".hydra/dockerfiles/claude/Dockerfile"

  [agents.gemini]
  dockerfile = ".hydra/dockerfiles/gemini/Dockerfile"

When a dockerfile is configured, hydra will build a custom image from it
instead of using the built-in default image.`,
	Args: cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectRoot, err := paths.GetProjectRootFromCwd()
		if err != nil {
			return errtrace.Wrap(err)
		}

		// Resolve which agent types to generate
		types, err := resolveAgentTypes(args)
		if err != nil {
			return errtrace.Wrap(err)
		}

		for _, agentType := range types {
			if err := writeDockerfileForAgent(agentType, projectRoot); err != nil {
				return errtrace.Wrap(err)
			}
		}

		fmt.Println()
		fmt.Println("To use a custom Dockerfile, add it to .hydra/config.toml:")
		fmt.Println()
		for _, agentType := range types {
			fmt.Printf("  [agents.%s]\n", agentType)
			fmt.Printf("  dockerfile = \".hydra/dockerfiles/%s/Dockerfile\"\n", agentType)
			fmt.Println()
		}
		fmt.Println("Then run 'hydra spawn' as usual - hydra will build a custom image from")
		fmt.Println("your Dockerfile instead of the built-in default.")

		return nil
	},
}

// resolveAgentTypes returns the list of AgentTypes to process.
// If args is empty, all known agent types are returned.
func resolveAgentTypes(args []string) ([]docker.AgentType, error) {
	all := []docker.AgentType{docker.AgentTypeClaude, docker.AgentTypeGemini}

	if len(args) == 0 {
		return all, nil
	}

	seen := map[docker.AgentType]bool{}
	var result []docker.AgentType
	for _, arg := range args {
		at := docker.AgentType(strings.ToLower(arg))
		switch at {
		case docker.AgentTypeClaude, docker.AgentTypeGemini:
			if !seen[at] {
				result = append(result, at)
				seen[at] = true
			}
		default:
			return nil, fmt.Errorf("unknown agent type %q; supported: claude, gemini", arg)
		}
	}
	return result, nil
}

// writeDockerfileForAgent writes the built-in Dockerfile and entrypoint.sh for
// agentType into <projectRoot>/.hydra/dockerfiles/<type>/.
func writeDockerfileForAgent(agentType docker.AgentType, projectRoot string) error {
	outDir := filepath.Join(projectRoot, ".hydra", "dockerfiles", string(agentType))
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create dockerfile dir: %w", err))
	}

	// Determine Dockerfile content for this agent type
	var dockerfileContent string
	switch agentType {
	case docker.AgentTypeClaude:
		dockerfileContent = config.DefaultDockerfileClaude
	case docker.AgentTypeGemini:
		dockerfileContent = config.DefaultDockerfileGemini
	default:
		return fmt.Errorf("unknown agent type: %q", agentType)
	}

	dockerfilePath := filepath.Join(outDir, "Dockerfile")
	entrypointPath := filepath.Join(outDir, "entrypoint.sh")

	if err := writeFileIfChanged(dockerfilePath, dockerfileContent, 0644); err != nil {
		return errtrace.Wrap(err)
	}
	if err := writeFileIfChanged(entrypointPath, config.DefaultEntrypointScript, 0755); err != nil {
		return errtrace.Wrap(err)
	}

	fmt.Printf("Wrote %s Dockerfile to %s\n", agentType, outDir)
	return nil
}

// writeFileIfChanged writes content to path only when it differs from the existing file.
// Reports whether the file was (over)written.
func writeFileIfChanged(path, content string, perm os.FileMode) error {
	existing, err := os.ReadFile(path)
	if err == nil && string(existing) == content {
		return nil // already up to date
	}
	return errtrace.Wrap(os.WriteFile(path, []byte(content), perm))
}
