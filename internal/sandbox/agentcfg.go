package sandbox

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"

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
// Hydra, invoking the hydra binary at hydraBin (its real host path, visible
// inside the sandbox via the read-only root bind).
func HookCommand(hydraBin, agent string) string {
	return shellQuote(hydraBin) + " trigger-hook " + agent
}

// shellQuote single-quotes s for safe embedding in a hook command string.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// BuildClaudeSettings generates the settings.json content with hook configuration for Claude Code.
func BuildClaudeSettings(existing []byte, hydraBin string) ([]byte, error) {
	hooks := buildHooksMap(HookCommand(hydraBin, "claude"), []string{
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
func BuildGeminiSettings(existing []byte, hydraBin string) ([]byte, error) {
	hooks := buildHooksMap(HookCommand(hydraBin, "gemini"), []string{
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
func BuildCopilotHooks(hydraBin string) ([]byte, error) {
	type hookEntry struct {
		Type string `json:"type"`
		Bash string `json:"bash"`
	}
	type hooksFile struct {
		Version int                    `json:"version"`
		Hooks   map[string][]hookEntry `json:"hooks"`
	}

	cmd := shellQuote(hydraBin) + " trigger-hook copilot"
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

// AgentArgv returns the command line to run inside the sandbox for the given
// agent type. resume runs the agent's own resume flow (continuing the prior
// conversation, so no task prompt is passed); otherwise prompt (if non-empty)
// is passed as the task. The permission-bypass mode flag
// (--dangerously-skip-permissions / --approval-mode=yolo / --yolo) is applied in
// BOTH cases — a resumed agent must stay non-interactive.
//
// systemPrompt holds the standing Hydra instructions, delivered as a system
// prompt, never as part of the user's task: Claude takes them via
// --append-system-prompt (applied on resume too). Gemini and Copilot have no
// such flag, so for them the instructions are seeded as context files (see
// seedHead, which also runs on resume) and systemPrompt is ignored here.
func AgentArgv(agentType AgentType, resume bool, systemPrompt, prompt string) ([]string, error) {
	switch agentType {
	case AgentTypeClaude:
		argv := []string{"claude", "--dangerously-skip-permissions"}
		if systemPrompt != "" {
			argv = append(argv, "--append-system-prompt", systemPrompt)
		}
		if resume {
			// --continue resumes the most recent conversation in the worktree
			// directly; --resume would pop an interactive session picker that
			// exits the process if cancelled.
			return append(argv, "--continue"), nil
		}
		if prompt != "" {
			argv = append(argv, "--", prompt)
		}
		return argv, nil
	case AgentTypeGemini:
		argv := []string{"gemini", "--approval-mode=yolo"}
		if resume {
			// "latest" resumes the most recent session non-interactively.
			return append(argv, "--resume", "latest"), nil
		}
		if prompt != "" {
			argv = append(argv, "-i", prompt)
		}
		return argv, nil
	case AgentTypeCopilot:
		argv := []string{"copilot", "--yolo"}
		if resume {
			return append(argv, "--resume"), nil
		}
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
