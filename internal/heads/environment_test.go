package heads

import (
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func environmentMap(env []string) map[string]string {
	out := make(map[string]string, len(env))
	for _, entry := range env {
		if key, value, ok := strings.Cut(entry, "="); ok {
			out[key] = value
		}
	}
	return out
}

func TestBuildAgentEnvUsesAllowList(t *testing.T) {
	source := []string{
		"PATH=/custom/bin:/usr/bin",
		"SHELL=/bin/zsh",
		"HOME=/daemon/home",
		"LANG=host-locale",
		"TMPDIR=/daemon/tmp",
		"HYDRA_STATE_DIR=/daemon/state",
		"UNRELATED_SECRET=do-not-copy",
		"ANTHROPIC_API_KEY=claude-key",
		"OPENAI_API_KEY=openai-key",
		"ANDROID_HOME=/opt/android",
		"GOCACHE=/host/go-build",
		"PLAYWRIGHT_BROWSERS_PATH=/host/playwright",
	}
	got := environmentMap(buildAgentEnv(source, sandbox.AgentTypeClaude,
		[]string{"ANDROID_HOME", "GOCACHE", "PLAYWRIGHT_BROWSERS_PATH", "HYDRA_STATE_DIR", "HOME"},
		"/home/head", "head", "Agent", "agent@example.com"))

	want := map[string]string{
		"HOME": "/home/head", "USER": "head", "LOGNAME": "head",
		"PATH": "/custom/bin:/usr/bin", "SHELL": "/bin/zsh",
		"LANG": "C.UTF-8", "TERM": "xterm-256color", "COLORTERM": "truecolor",
		"TMPDIR": "/tmp", "TMP": "/tmp", "TEMP": "/tmp",
		"ANTHROPIC_API_KEY": "claude-key", "ANDROID_HOME": "/opt/android",
		"GOCACHE": "/host/go-build", "PLAYWRIGHT_BROWSERS_PATH": "/host/playwright",
		"GIT_AUTHOR_NAME": "Agent", "GIT_COMMITTER_NAME": "Agent",
		"GIT_AUTHOR_EMAIL": "agent@example.com", "GIT_COMMITTER_EMAIL": "agent@example.com",
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("%s = %q, want %q", key, got[key], value)
		}
	}
	for _, absent := range []string{"HYDRA_STATE_DIR", "UNRELATED_SECRET", "OPENAI_API_KEY"} {
		if _, ok := got[absent]; ok {
			t.Errorf("unexpected inherited variable %s", absent)
		}
	}
}

func TestBuildAgentEnvSeparatesProviderAuthentication(t *testing.T) {
	source := []string{
		"PATH=/bin",
		"ANTHROPIC_API_KEY=anthropic",
		"OPENAI_API_KEY=openai",
		"GEMINI_API_KEY=gemini",
		"GITHUB_TOKEN=github",
	}
	tests := []struct {
		agent sandbox.AgentType
		key   string
	}{
		{sandbox.AgentTypeClaude, "ANTHROPIC_API_KEY"},
		{sandbox.AgentTypeCodex, "OPENAI_API_KEY"},
		{sandbox.AgentTypeGemini, "GEMINI_API_KEY"},
		{sandbox.AgentTypeCopilot, "GITHUB_TOKEN"},
	}
	providerKeys := []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN"}
	for _, tc := range tests {
		t.Run(string(tc.agent), func(t *testing.T) {
			got := environmentMap(buildAgentEnv(source, tc.agent, nil, "/home/head", "head", "", ""))
			for _, key := range providerKeys {
				_, present := got[key]
				if present != (key == tc.key) {
					t.Errorf("%s present = %t, want %t", key, present, key == tc.key)
				}
			}
		})
	}
}

func TestBuildAgentEnvUsesFallbacks(t *testing.T) {
	got := environmentMap(buildAgentEnv([]string{"USER=daemon-user"}, sandbox.AgentTypeBash, nil, "/home/head", "", "", ""))
	if got["PATH"] != fallbackHeadPath {
		t.Errorf("PATH = %q, want fallback %q", got["PATH"], fallbackHeadPath)
	}
	if got["SHELL"] != "/bin/bash" {
		t.Errorf("SHELL = %q, want /bin/bash", got["SHELL"])
	}
	if got["USER"] != "daemon-user" || got["LOGNAME"] != "daemon-user" {
		t.Errorf("fallback identity = USER %q LOGNAME %q", got["USER"], got["LOGNAME"])
	}
}
