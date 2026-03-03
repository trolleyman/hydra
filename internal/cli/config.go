package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/docker"
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
	Short: "Initialize project configuration with default Dockerfiles",
	Long: `Generate and put the default Dockerfiles (and required files, namely entrypoint.sh),
in .hydra/config/{gemini,claude}/ which can then be modified to edit the default
dockerfiles for these agents.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		projectRoot, err := paths.GetProjectRootFromCwd()
		if err != nil {
			return errtrace.Wrap(err)
		}

		agentTypes := []docker.AgentType{docker.AgentTypeClaude, docker.AgentTypeGemini}
		for _, agentType := range agentTypes {
			if err := writeDefaultConfigForAgent(agentType, projectRoot); err != nil {
				return errtrace.Wrap(err)
			}
		}

		fmt.Println("Project configuration initialized in .hydra/config/")
		return nil
	},
}

func writeDefaultConfigForAgent(agentType docker.AgentType, projectRoot string) error {
	outDir := filepath.Join(projectRoot, ".hydra", "config", string(agentType))
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return errtrace.Wrap(fmt.Errorf("create config dir: %w", err))
	}

	var dockerfileContent = fmt.Sprintf(`FROM %s

# Add additional necessary steps to e.g. add developer tools
#RUN apt install ...
`, docker.GetDefaultImageTag(agentType))

	dockerfilePath := filepath.Join(outDir, "Dockerfile")

	if err := paths.WriteFileIfChanged(dockerfilePath, dockerfileContent, 0644); err != nil {
		return errtrace.Wrap(err)
	}

	fmt.Printf("Wrote %s default config to %s\n", agentType, outDir)
	return nil
}
