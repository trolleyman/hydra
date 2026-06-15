package sandbox

import (
	"encoding/json"
	"fmt"
	"log"

	"braces.dev/errtrace"
)

// This file holds the per-agent configuration generators (moved from the old
// internal/docker package). They produce the settings/hooks JSON that registers
// Hydra's status hooks and pre-accepts trust dialogs. The seeding orchestration
// (writing files + building Binds) lives in internal/heads.

// hookHandler is a single hook handler entry in a hooks settings.json.
type hookHandler struct {
	Type    string `json:"type"`
	Command string `json:"command"`
}

// matcherGroup is a matcher group (with optional matcher) in a hooks settings.json.
type matcherGroup struct {
	Hooks []hookHandler `json:"hooks"`
}

// buildHooksMap constructs a hooks map from a list of event names, all sharing the same command.
func buildHooksMap(cmd string, events []string) map[string]interface{} {
	group := []matcherGroup{{Hooks: []hookHandler{{Type: "command", Command: cmd}}}}
	m := make(map[string]interface{}, len(events))
	for _, event := range events {
		m[event] = group
	}
	return m
}

// HookCommand returns the shell command a hook runs to report status back to
// Hydra. The hydra binary is bound into the sandbox at $HOME/.hydra/hydra.
func HookCommand(agent string) string {
	return "$HOME/.hydra/hydra trigger-hook " + agent
}

// BuildClaudeSettings generates the settings.json content with hook configuration for Claude Code.
func BuildClaudeSettings(existing []byte) ([]byte, error) {
	hooks := buildHooksMap(HookCommand("claude"), []string{
		"SessionStart",
		"UserPromptSubmit",
		"PreToolUse",
		"PostToolUse",
		"PostToolUseFailure",
		"Notification",
		"Stop",
		"PreCompact",
		"SubagentStart",
		"SubagentStop",
		"SessionEnd",
	})

	settings := make(map[string]interface{})
	if len(existing) > 0 {
		if err := json.Unmarshal(existing, &settings); err != nil {
			log.Printf("warn: failed to unmarshal existing claude settings: %v", err)
		}
	}

	settings["skipDangerousModePermissionPrompt"] = true
	settings["hooks"] = hooks

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal claude settings: %w", err))
	}
	return data, nil
}

// BuildClaudeConfig generates the .claude.json content with project trust settings.
func BuildClaudeConfig(existing []byte, worktreePath string) ([]byte, error) {
	cfg := make(map[string]interface{})
	if len(existing) > 0 {
		if err := json.Unmarshal(existing, &cfg); err != nil {
			log.Printf("warn: failed to unmarshal existing claude config: %v", err)
		}
	}

	projects, _ := cfg["projects"].(map[string]interface{})
	if projects == nil {
		projects = make(map[string]interface{})
	}
	project, _ := projects[worktreePath].(map[string]interface{})
	if project == nil {
		project = make(map[string]interface{})
	}
	project["hasTrustDialogAccepted"] = true
	projects[worktreePath] = project
	cfg["projects"] = projects

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal claude config: %w", err))
	}
	return data, nil
}

// BuildGeminiSettings generates the settings.json content with hook configuration for Gemini CLI.
func BuildGeminiSettings(existing []byte) ([]byte, error) {
	hooks := buildHooksMap(HookCommand("gemini"), []string{
		"SessionStart",
		"BeforeAgent",
		"AfterAgent",
		"BeforeTool",
		"AfterTool",
		"Notification",
		"PreCompress",
		"SessionEnd",
	})

	settings := make(map[string]interface{})
	if len(existing) > 0 {
		if err := json.Unmarshal(existing, &settings); err != nil {
			log.Printf("warn: failed to unmarshal existing gemini settings: %v", err)
		}
	}

	settings["hooks"] = hooks

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal gemini settings: %w", err))
	}
	return data, nil
}

// BuildCopilotHooks generates a hooks JSON file for GitHub Copilot CLI.
// Copilot CLI loads hooks from .github/hooks/*.json in the working directory.
// The format differs from Claude/Gemini: it uses {"version":1,"hooks":{...}}.
func BuildCopilotHooks() ([]byte, error) {
	type hookEntry struct {
		Type string `json:"type"`
		Bash string `json:"bash"`
	}
	type hooksFile struct {
		Version int                    `json:"version"`
		Hooks   map[string][]hookEntry `json:"hooks"`
	}

	cmd := "\"$HOME/.hydra/hydra\" trigger-hook copilot"
	hf := hooksFile{
		Version: 1,
		Hooks: map[string][]hookEntry{
			"sessionStart":        {{Type: "command", Bash: cmd + " sessionStart"}},
			"userPromptSubmitted": {{Type: "command", Bash: cmd + " userPromptSubmitted"}},
			"preToolUse":          {{Type: "command", Bash: cmd + " preToolUse"}},
			"postToolUse":         {{Type: "command", Bash: cmd + " postToolUse"}},
			"sessionEnd":          {{Type: "command", Bash: cmd + " sessionEnd"}},
		},
	}

	data, err := json.MarshalIndent(hf, "", "  ")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal copilot hooks: %w", err))
	}
	return data, nil
}

// CombinePrompt joins a pre-prompt and prompt with a newline.
func CombinePrompt(prePrompt, prompt string) string {
	if prePrompt == "" {
		return prompt
	}
	return prePrompt + "\n" + prompt
}

// AgentArgv returns the command line to run inside the sandbox for the given
// agent type. resume runs the agent's own resume flow; otherwise prompt (if
// non-empty) is passed as the task.
func AgentArgv(agentType AgentType, resume bool, prompt string) ([]string, error) {
	switch agentType {
	case AgentTypeClaude:
		if resume {
			return []string{"claude", "--resume"}, nil
		}
		argv := []string{"claude", "--dangerously-skip-permissions"}
		if prompt != "" {
			argv = append(argv, "--", prompt)
		}
		return argv, nil
	case AgentTypeGemini:
		if resume {
			return []string{"gemini", "--resume"}, nil
		}
		argv := []string{"gemini", "--approval-mode=yolo"}
		if prompt != "" {
			argv = append(argv, "-i", prompt)
		}
		return argv, nil
	case AgentTypeCopilot:
		if resume {
			return []string{"copilot", "--resume"}, nil
		}
		argv := []string{"copilot", "--yolo"}
		if prompt != "" {
			argv = append(argv, "--autopilot", "-p", prompt)
		}
		return argv, nil
	case AgentTypeBash:
		return []string{"/bin/bash"}, nil
	default:
		return nil, errtrace.Wrap(fmt.Errorf("unknown agent type: %q", agentType))
	}
}
