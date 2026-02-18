package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/cockroachdb/errors"
	"github.com/trolleyman/hydra/internal/config"
)

// promptYesNo prints question and reads a y/n answer from stdin.
// Returns defaultYes when the user presses Enter without typing anything.
func promptYesNo(question string, defaultYes bool) bool {
	hint := "[Y/n]"
	if !defaultYes {
		hint = "[y/N]"
	}
	fmt.Printf("%s %s ", question, hint)
	resp, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	resp = strings.TrimSpace(strings.ToLower(resp))
	if resp == "" {
		return defaultYes
	}
	return resp == "y" || resp == "yes"
}

// promptAgentChoice asks the user to pick an agent type interactively.
func promptAgentChoice() (config.AgentType, error) {
	fmt.Println("Which AI agent would you like to set up?")
	fmt.Println("  [1] Claude Code  (Anthropic)")
	fmt.Println("  [2] Gemini CLI   (Google)")
	fmt.Print("Choice [1]: ")

	resp, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("read input: %w", err)
	}
	switch strings.TrimSpace(resp) {
	case "", "1":
		return config.AgentClaude, nil
	case "2":
		return config.AgentGemini, nil
	default:
		return "", fmt.Errorf("invalid choice; enter 1 or 2")
	}
}

// ensureDockerfile returns the Dockerfile path, prompting the user to create
// one if none is found. It is safe to call from both spawn and tui.
func ensureDockerfile(cfg *config.Config, projectRoot, override string) (string, error) {
	path, err := config.FindDockerfile(cfg, projectRoot, override)
	if err == nil {
		return path, nil
	}
	if !errors.Is(err, config.ErrNoDockerfile) {
		return "", err
	}

	fmt.Println("No agent Dockerfile found for this project.")
	fmt.Println("A Dockerfile defines the AI agent environment (Claude, Gemini, etc.).")
	fmt.Println()

	if !promptYesNo("Create one now?", true) {
		return "", fmt.Errorf("no Dockerfile; run 'hydra config init' to create one")
	}
	fmt.Println()

	agent, err := promptAgentChoice()
	if err != nil {
		return "", err
	}

	dockerfilePath := config.DefaultDockerfilePath(projectRoot)
	if err := config.WriteDockerfile(agent, dockerfilePath); err != nil {
		return "", fmt.Errorf("write Dockerfile: %w", err)
	}

	fmt.Printf("\nCreated %s Dockerfile at %s\n", agent, dockerfilePath)
	fmt.Println("Edit it to customise the agent environment, then re-run your command.")
	fmt.Println()
	return dockerfilePath, nil
}
