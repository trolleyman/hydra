// Package agentenv constructs the deliberately narrow environment inherited by
// sandboxed provider processes.
package agentenv

import (
	"os"
	"strings"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/sandbox"
)

const fallbackPath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

var providerAuth = map[sandbox.AgentType][]string{
	sandbox.AgentTypeClaude:  {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"},
	sandbox.AgentTypeCodex:   {"OPENAI_API_KEY"},
	sandbox.AgentTypeGemini:  {"GEMINI_API_KEY", "GOOGLE_API_KEY"},
	sandbox.AgentTypeCopilot: {"COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"},
}

// FromHost builds a provider environment from the current process without
// copying unrelated variables or credentials.
func FromHost(agentType sandbox.AgentType, inherit []string, home, username, gitAuthorName, gitAuthorEmail string) []string {
	return Build(os.Environ(), agentType, inherit, home, username, gitAuthorName, gitAuthorEmail)
}

// Build is the pure form of FromHost. Hydra-owned baseline values come first,
// followed by credentials for the selected provider and explicitly inherited
// names. Reserved Hydra variables are skipped defensively.
func Build(source []string, agentType sandbox.AgentType, inherit []string, home, username, gitAuthorName, gitAuthorEmail string) []string {
	sourceValues := make(map[string]string, len(source))
	for _, entry := range source {
		if key, value, ok := strings.Cut(entry, "="); ok {
			sourceValues[key] = value
		}
	}

	path := sourceValues["PATH"]
	if path == "" {
		path = fallbackPath
	}
	shell := sourceValues["SHELL"]
	if shell == "" {
		shell = "/bin/bash"
	}
	if username == "" {
		username = sourceValues["USER"]
	}

	env := []string{
		"HOME=" + home,
		"USER=" + username,
		"LOGNAME=" + username,
		"PATH=" + path,
		"SHELL=" + shell,
		"LANG=C.UTF-8",
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TMPDIR=/tmp",
		"TMP=/tmp",
		"TEMP=/tmp",
	}

	selected := append([]string(nil), providerAuth[agentType]...)
	selected = append(selected, inherit...)
	seen := make(map[string]bool, len(selected))
	for _, name := range selected {
		if seen[name] || config.ValidateInheritedEnvName(name) != nil {
			continue
		}
		seen[name] = true
		if value, ok := sourceValues[name]; ok {
			env = append(env, name+"="+value)
		}
	}

	if gitAuthorName != "" {
		env = append(env, "GIT_AUTHOR_NAME="+gitAuthorName, "GIT_COMMITTER_NAME="+gitAuthorName)
	}
	if gitAuthorEmail != "" {
		env = append(env, "GIT_AUTHOR_EMAIL="+gitAuthorEmail, "GIT_COMMITTER_EMAIL="+gitAuthorEmail)
	}
	return env
}
