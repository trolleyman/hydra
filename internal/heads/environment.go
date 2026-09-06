package heads

import (
	"os"
	"strings"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/sandbox"
)

const fallbackHeadPath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

// providerAuthEnv is the narrow compatibility surface for users who authenticate
// an agent through its conventional environment variables instead of credential
// files. A head receives credentials for its own provider only.
var providerAuthEnv = map[sandbox.AgentType][]string{
	sandbox.AgentTypeClaude: {
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN",
	},
	sandbox.AgentTypeCodex: {
		"OPENAI_API_KEY",
	},
	sandbox.AgentTypeGemini: {
		"GEMINI_API_KEY",
		"GOOGLE_API_KEY",
	},
	sandbox.AgentTypeCopilot: {
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN",
	},
}

// agentEnv builds one sandboxed head environment from the daemon environment.
// The source is allow-listed by buildAgentEnv; it is never copied wholesale.
func agentEnv(agentType sandbox.AgentType, inherit []string, home, username, gitAuthorName, gitAuthorEmail string) []string {
	return buildAgentEnv(os.Environ(), agentType, inherit, home, username, gitAuthorName, gitAuthorEmail)
}

// buildAgentEnv is the pure implementation used by tests. Hydra-owned baseline
// values come first, followed by provider authentication and explicitly opted-in
// names. Config validation rejects reserved names; this function also skips them
// defensively for Config values assembled directly in Go.
func buildAgentEnv(source []string, agentType sandbox.AgentType, inherit []string, home, username, gitAuthorName, gitAuthorEmail string) []string {
	sourceValues := make(map[string]string, len(source))
	for _, entry := range source {
		if key, value, ok := strings.Cut(entry, "="); ok {
			sourceValues[key] = value
		}
	}

	path := sourceValues["PATH"]
	if path == "" {
		path = fallbackHeadPath
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

	selected := make([]string, 0, len(providerAuthEnv[agentType])+len(inherit))
	selected = append(selected, providerAuthEnv[agentType]...)
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
		env = append(env,
			"GIT_AUTHOR_NAME="+gitAuthorName,
			"GIT_COMMITTER_NAME="+gitAuthorName,
		)
	}
	if gitAuthorEmail != "" {
		env = append(env,
			"GIT_AUTHOR_EMAIL="+gitAuthorEmail,
			"GIT_COMMITTER_EMAIL="+gitAuthorEmail,
		)
	}
	return env
}
