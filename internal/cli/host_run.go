package cli

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/gate"
)

func init() {
	rootCmd.AddCommand(hostRunCmd)
}

// hostRunExitDenied is the exit code `hydra host-run` uses when the user denies
// the request (or it times out / has no approval channel), kept distinct from a
// command's own exit codes so the agent can tell "you weren't allowed to run
// this" from "the command ran and failed".
const hostRunExitDenied = 77

// hostRunCmd is the sandbox escape hatch: an agent runs `hydra host-run -- <cmd>`
// to ask the user to run one command OUTSIDE the sandbox, on the host, in the
// head's worktree. It parks an approval (reusing the gate's request/decision file
// channel, so it surfaces as the normal approval card) and blocks until the user
// allows or denies in the UI. On allow, the DAEMON runs the command host-side and
// writes the result back here, which this command relays to stdout/stderr and
// mirrors as its own exit code. This is a deliberate, heavily-gated last resort -
// the pre-prompt tells agents it is for extremely rare cases only.
var hostRunCmd = &cobra.Command{
	Use:   "host-run [-- ] <command>...",
	Short: "Request the user's approval to run a command on the host (outside the sandbox)",
	Long: `Ask the user to run a single command on the HOST, outside your sandbox, in your
worktree. The command is shown to the user for approval; nothing runs unless they
allow it. This is an escape hatch of last resort - almost everything belongs
inside the sandbox. Use it only when a task genuinely cannot proceed otherwise,
and expect most requests to be denied.

The command's stdout and stderr are relayed back to you, and this command exits
with the host command's own exit code (or ` + strconv.Itoa(hostRunExitDenied) + ` if the request is denied or
times out).`,
	Args:               cobra.MinimumNArgs(1),
	DisableFlagParsing: true, // the whole argv after `host-run` is the command
	RunE: func(cmd *cobra.Command, args []string) error {
		code := runHostRun(args)
		os.Exit(code)
		return nil
	},
}

// runHostRun submits the host-command approval and blocks for the outcome,
// returning the exit code to surface to the agent. All human-facing text goes to
// stdout/stderr here (this is a leaf CLI the agent reads directly), unlike the
// gate/mcp hooks which speak a machine protocol.
func runHostRun(args []string) int {
	// A leading "--" is a conventional separator; drop one if present.
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	command := strings.TrimSpace(strings.Join(args, " "))
	if command == "" {
		fmt.Fprintln(os.Stderr, "host-run: no command given")
		return hostRunExitDenied
	}

	dir := os.Getenv(gate.EnvApprovalDir)
	if dir == "" {
		fmt.Fprintln(os.Stderr, "host-run: no approval channel is available, so a host command can't be requested right now.")
		return hostRunExitDenied
	}

	reqid := strconv.FormatInt(time.Now().UnixNano(), 10)
	summary := "wants to run a command on the host"
	req := gate.Request{
		ReqID:   reqid,
		Tool:    "host-run",
		Kind:    "host_command",
		Target:  command,
		Reason:  "the agent asked to run a command outside its sandbox, on the host",
		Summary: summary,
		TS:      time.Now().Format(time.RFC3339Nano),
	}
	if err := gate.WriteRequest(dir, req); err != nil {
		fmt.Fprintf(os.Stderr, "host-run: failed to submit the request: %v\n", err)
		return hostRunExitDenied
	}
	// Retire the request/decision/result files once we're done, so a resolved
	// approval stops being surfaced and the dir doesn't accumulate.
	defer gate.RemoveRequest(dir, reqid)

	fmt.Fprintln(os.Stderr, "host-run: waiting for the user to approve running this command on the host...")

	deadline := time.Now().Add(askTimeout)
	for {
		// Keep the approval card visible: no Claude hook fires while this CLI blocks,
		// so nothing else re-stamps the status.
		writeApprovalStatus(summary)
		if d, ok, err := gate.ReadDecision(dir, reqid); err == nil && ok {
			if d.Decision != gate.Allow {
				fmt.Fprintln(os.Stderr, "host-run: the user denied this command.")
				writeRunningStatus("host command denied")
				return hostRunExitDenied
			}
			return awaitHostRunResult(dir, reqid, deadline)
		}
		if time.Now().After(deadline) {
			fmt.Fprintln(os.Stderr, "host-run: the request timed out without a decision.")
			writeRunningStatus("host command request timed out")
			return hostRunExitDenied
		}
		time.Sleep(askPollInterval)
	}
}

// awaitHostRunResult waits for the daemon to run the approved command host-side
// and write its result, then relays output + exit code. The daemon executes
// promptly on approval, but the command itself may run a while, so this keeps
// polling to the same overall deadline.
func awaitHostRunResult(dir, reqid string, deadline time.Time) int {
	writeRunningStatus("running approved host command")
	for {
		if r, ok, err := gate.ReadHostRunResult(dir, reqid); err == nil && ok {
			writeRunningStatus("host command finished")
			return relayHostRunResult(r)
		}
		if time.Now().After(deadline) {
			fmt.Fprintln(os.Stderr, "host-run: approved, but the host command did not return in time.")
			writeRunningStatus("host command did not return in time")
			return hostRunExitDenied
		}
		time.Sleep(askPollInterval)
	}
}

// relayHostRunResult prints a completed host-run result the way a normal command
// would appear and returns the exit code to propagate.
func relayHostRunResult(r gate.HostRunResult) int {
	if r.Error != "" {
		fmt.Fprintf(os.Stderr, "host-run: %s\n", r.Error)
		return hostRunExitDenied
	}
	if r.Output != "" {
		if r.Truncated {
			fmt.Fprintln(os.Stdout, "[host-run: output truncated to the last portion]")
		}
		fmt.Fprint(os.Stdout, r.Output)
		if !strings.HasSuffix(r.Output, "\n") {
			fmt.Fprintln(os.Stdout)
		}
	}
	if r.TimedOut {
		fmt.Fprintln(os.Stderr, "host-run: the command was killed at the host execution timeout.")
	}
	return r.ExitCode
}
