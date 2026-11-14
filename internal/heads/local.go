package heads

import (
	"strings"

	"github.com/trolleyman/hydra/internal/config"
)

// localExecutionPrompt replaces the sandbox-specific built-in instructions while
// retaining the workflow and all project/user instructions appended after them.
func localExecutionPrompt(prompt string, chatMode bool) string {
	start := strings.Index(config.DefaultPrePrompt, "## Environment")
	end := strings.Index(config.DefaultPrePrompt, "## Workflow")
	if start >= 0 && end > start {
		// Launch has already substituted placeholders in the environment section.
		actualStart := strings.Index(prompt, "## Environment")
		actualEnd := strings.Index(prompt, "## Workflow")
		if actualStart >= 0 && actualEnd > actualStart {
			prompt = prompt[:actualStart] + "## Environment\n- You run directly on the host as the user, without an OS sandbox. Filesystem, credential, network, and Git isolation are not enforced.\n- Work in your dedicated worktree, not the main repository.\n" + config.RunModeLine(chatMode) + "\n" + prompt[actualEnd:]
		}
	}
	return prompt
}

func localRuntimeEnv(env []string, tmpDir string) []string {
	return append(append([]string(nil), env...), "TMPDIR="+tmpDir, "TMP="+tmpDir, "TEMP="+tmpDir)
}
