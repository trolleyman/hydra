package heads

import (
	"github.com/trolleyman/hydra/internal/agentenv"
	"github.com/trolleyman/hydra/internal/sandbox"
)

const fallbackHeadPath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

// agentEnv builds one sandboxed head environment from the daemon environment.
// The source is allow-listed by buildAgentEnv; it is never copied wholesale.
func agentEnv(agentType sandbox.AgentType, inherit []string, home, username, gitAuthorName, gitAuthorEmail string) []string {
	return agentenv.FromHost(agentType, inherit, home, username, gitAuthorName, gitAuthorEmail)
}

// buildAgentEnv is the pure implementation used by tests. Hydra-owned baseline
// values come first, followed by provider authentication and explicitly opted-in
// names. Config validation rejects reserved names; this function also skips them
// defensively for Config values assembled directly in Go.
func buildAgentEnv(source []string, agentType sandbox.AgentType, inherit []string, home, username, gitAuthorName, gitAuthorEmail string) []string {
	return agentenv.Build(source, agentType, inherit, home, username, gitAuthorName, gitAuthorEmail)
}
