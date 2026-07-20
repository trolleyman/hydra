package http

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"time"

	"github.com/trolleyman/hydra/internal/gate"
)

// hostRunTimeout bounds how long an approved host command may run before the
// daemon kills it. Generous (a host build/tool may be slow), but finite so a
// runaway command can't wedge a slot forever. Stays comfortably under the
// in-sandbox CLI's own overall deadline (askTimeout) minus the approval wait, so
// the CLI is still polling for the result when it lands.
const hostRunTimeout = 8 * time.Minute

// hostRunOutputCap bounds the combined stdout+stderr relayed back to the agent.
// A large build log is tail-capped (the end is usually where the error is) so a
// pathological command can't blow up the result file or the agent's context.
const hostRunOutputCap = 64 * 1024

// runApprovedHostCommand executes an approved host_command OUTSIDE the sandbox,
// on the host, in the head's worktree, and writes the result for the blocked
// `hydra host-run` CLI to relay to the agent.
//
// command is the exact text the UI displayed and the user approved - passed
// through from the decision request, NOT re-read from the head-writable request
// file. That echo-back is the whole TOCTOU defense: the agent cannot swap in a
// different command after the user has seen and approved one.
//
// It runs asynchronously (the HTTP handler returns immediately after writing the
// allow decision); the CLI reads the allow, then polls for the result this writes.
func runApprovedHostCommand(dir, reqid, worktree, command string) {
	if worktree == "" {
		_ = gate.WriteHostRunResult(dir, reqid, gate.HostRunResult{
			ExitCode: 1,
			Error:    "the head has no worktree to run the command in",
		})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), hostRunTimeout)
	defer cancel()

	// bash -lc runs the command as the host user with a login shell, exactly like a
	// human typing it in the worktree - the point of the escape hatch is unconfined
	// host execution, so there is deliberately no sandbox wrapper here.
	cmd := exec.CommandContext(ctx, "bash", "-lc", command)
	cmd.Dir = worktree
	cmd.Env = os.Environ()

	out, err := cmd.CombinedOutput()
	res := gate.HostRunResult{Output: capTail(string(out), hostRunOutputCap)}
	if len(out) > hostRunOutputCap {
		res.Truncated = true
	}
	if ctx.Err() == context.DeadlineExceeded {
		res.TimedOut = true
		res.ExitCode = 124 // conventional timeout exit code
		if err := gate.WriteHostRunResult(dir, reqid, res); err != nil {
			log.Printf("hydra: write host-run result for %s: %v", reqid, err)
		}
		return
	}
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			res.ExitCode = exitErr.ExitCode()
		} else {
			// Failed to start at all (e.g. bash missing) - not a command exit code.
			res.ExitCode = 1
			res.Error = fmt.Sprintf("failed to run the command: %v", err)
		}
	}
	if err := gate.WriteHostRunResult(dir, reqid, res); err != nil {
		log.Printf("hydra: write host-run result for %s: %v", reqid, err)
	}
}

// capTail returns the last max bytes of s (the tail is where a failing command's
// error usually is). s shorter than max is returned unchanged.
func capTail(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[len(s)-max:]
}
