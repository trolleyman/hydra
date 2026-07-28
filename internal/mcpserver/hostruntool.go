package mcpserver

import (
	"encoding/json"
	"strings"
)

// hostRunToolDef is the sandbox escape hatch as a first-class tool, advertised
// when Deps.HostRun is wired (i.e. the head has an approval channel).
//
// It supersedes `hydra host-run` run through Bash. That spelling put the command
// through the sandbox's own shell first, which ate any unquoted pipe, redirection
// or `&&` before host-run ever saw it - so the chat and the approval card could
// disagree about what would actually run, and an agent writing the obvious thing
// silently asked for something else. A structured argument has no shell to cross:
// what the agent puts in `command` is exactly what the card shows and exactly what
// the daemon runs.
//
// `why` is REQUIRED here, which the CLI could not enforce (an argv is just words,
// and refusing one would have stranded agents that predate the flag). The tool
// can, and the explanation is the main thing a user judges the request on.
func hostRunToolDef() map[string]any {
	return map[string]any{
		"name": "host_run",
		"description": "LAST RESORT: ask the user to run ONE command on the HOST, outside your sandbox, in your worktree. " +
			"Nothing runs unless they allow it, and an unanswered request is denied after a few minutes. " +
			"Almost everything belongs inside the sandbox - prefer changing .hydra/config.toml (writable_paths, network, ...) or just asking in chat. " +
			"Reach for this only when there is genuinely no in-sandbox way to proceed, and expect to be denied.\n\n" +
			"`command` is run as `bash -lc <command>` on the host, in your worktree. It is passed through verbatim - no shell of yours touches it - so pipes, redirection and `&&` all work as written and need no extra quoting.\n\n" +
			"Ask ONCE for the whole job, with the SHORTEST command that does it. Every request interrupts the user, and they must read and understand every character before allowing it - a long script reads as a place for something to hide and gets denied. " +
			"So fold the steps that genuinely must run outside the sandbox into one command and leave out everything else: do the preparation, checking and reporting yourself, in the sandbox, before and after. " +
			"If the job is `git merge --no-edit main`, ask for exactly that - not the same thing wrapped in conditionals, fallbacks and echoes.\n\n" +
			"Returns the command's combined output and exit status.",
		"inputSchema": map[string]any{
			"type":     "object",
			"required": []string{"command", "why"},
			"properties": map[string]any{
				"command": map[string]any{
					"type":        "string",
					"description": "The command to run on the host, exactly as it should execute under `bash -lc`.",
				},
				"why": map[string]any{
					"type": "string",
					"description": "What you are trying to achieve and which specific sandbox limitation blocks it, written for a human who cannot see your reasoning " +
						"(e.g. \"merging main in has to write .git, which is read-only in my sandbox under git_isolation=readonly\"). Shown above the command in the approval card.",
				},
			},
		},
	}
}

// parseHostRun validates a host_run call's arguments. A non-empty error string is
// an agent-readable rejection.
func parseHostRun(raw json.RawMessage) (HostRunRequest, string) {
	var a struct {
		Command string `json:"command"`
		Why     string `json:"why"`
	}
	_ = json.Unmarshal(raw, &a)
	command := strings.TrimSpace(a.Command)
	why := strings.TrimSpace(a.Why)
	if command == "" {
		return HostRunRequest{}, "host_run requires a non-empty \"command\"."
	}
	if why == "" {
		return HostRunRequest{}, "host_run requires \"why\": what you are trying to achieve and which sandbox limitation blocks it. The user sees it above the command and it is the main thing they judge the request on - a request that only shows a shell script gets denied."
	}
	return HostRunRequest{Command: command, Why: why}, ""
}
