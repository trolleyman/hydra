package cli

import (
	"fmt"
	"os"
	"regexp"
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
	Use:   "host-run [--why <text>] [--] <command>...",
	Short: "Request the user's approval to run a command on the host (outside the sandbox)",
	Long: `Ask the user to run a single command on the HOST, outside your sandbox, in your
worktree. The command is shown to the user for approval; nothing runs unless they
allow it. This is an escape hatch of last resort - almost everything belongs
inside the sandbox. Use it only when a task genuinely cannot proceed otherwise,
and expect most requests to be denied.

Pass --why "<text>" to say what you are doing and why it cannot run inside the
sandbox. It is shown at the top of the approval card, above the command, and is
the main thing the user judges the request on - a request that only shows a shell
script makes them reverse-engineer your intent, and is far more likely to be
denied. Write it for a human: what you are trying to achieve, and which sandbox
limitation blocks it (e.g. "the merge has to write .git, which is read-only in my
sandbox under git_isolation=readonly").

Ask ONCE for the whole job. Every request interrupts the user, so put all the
steps you need into a single command (` + "`a && b && c`" + `, or a short script) rather
than firing off a series of small requests - each extra prompt is another
interruption, and a half-finished sequence is worse than one that runs as a unit.

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
	// Flag parsing is disabled (the argv after `host-run` is the command
	// verbatim), so --why is peeled off by hand ahead of the separator.
	why, args, err := takeWhyFlag(args)
	if err != "" {
		fmt.Fprintln(os.Stderr, "host-run: "+err)
		return hostRunExitDenied
	}
	// A leading "--" is a conventional separator; drop one if present.
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	command := hostRunCommandText(args)
	if command == "" {
		fmt.Fprintln(os.Stderr, "host-run: no command given")
		return hostRunExitDenied
	}
	if why == "" {
		// Not fatal - an un-explained request still goes through, since refusing
		// would strand an agent that just didn't know about the flag. But the card
		// is much weaker without it, so say so where the agent will read it.
		fmt.Fprintln(os.Stderr, `host-run: no --why given. Pass --why "<what this does and why it can't run in the sandbox>" - the user sees it above the command and is far more likely to allow a request that explains itself.`)
	}

	dir := os.Getenv(gate.EnvApprovalDir)
	if dir == "" {
		fmt.Fprintln(os.Stderr, "host-run: no approval channel is available, so a host command can't be requested right now.")
		return hostRunExitDenied
	}

	reqid := strconv.FormatInt(time.Now().UnixNano(), 10)
	// The summary is the one-liner that reaches the surfaces with no room for the
	// card - the OS notification, the head's last_message - so fold the agent's
	// explanation in when it gave one.
	summary := "wants to run a command on the host"
	if why != "" {
		summary += ": " + summaryWhy(why)
	}
	req := gate.Request{
		ReqID:       reqid,
		Tool:        "host-run",
		Kind:        "host_command",
		Target:      command,
		Reason:      "the agent asked to run a command outside its sandbox, on the host",
		Summary:     summary,
		Description: why,
		TS:          time.Now().Format(time.RFC3339Nano),
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

// maxWhyLen caps the stored explanation. It is rendered in an approval card and
// an OS notification, both of which a wall of text would swamp - and an
// explanation that long is a sign the request should have been a conversation.
const maxWhyLen = 600

// takeWhyFlag peels a leading --why/--description (in either `--why <text>` or
// `--why=<text>` form) off the argv, returning the text and the remaining args.
// It only looks at the front: past the first non-flag word every byte belongs to
// the command, so a `--why` appearing there is the command's own argument and is
// left alone. A non-empty error string is a usage mistake to report.
func takeWhyFlag(args []string) (why string, rest []string, errMsg string) {
	for len(args) > 0 {
		a := args[0]
		name, value, hasValue := strings.Cut(a, "=")
		if name != "--why" && name != "--description" {
			break
		}
		if hasValue {
			why, args = value, args[1:]
			continue
		}
		if len(args) < 2 {
			return "", nil, name + " needs a value: --why \"<what this does and why it can't run in the sandbox>\""
		}
		why, args = args[1], args[2:]
	}
	why = strings.TrimSpace(why)
	if len(why) > maxWhyLen {
		why = strings.TrimSpace(why[:maxWhyLen]) + "..."
	}
	return why, args, ""
}

// maxSummaryWhyLen caps how much of the explanation rides in the summary. The
// full text goes in Description and is shown in the card; the summary is for the
// one-line surfaces (the OS notification body, the head's last_message), where a
// paragraph reads as a wall.
const maxSummaryWhyLen = 120

// summaryWhy condenses the explanation to one short line for those surfaces.
func summaryWhy(s string) string {
	line := firstLine(s)
	if len(line) <= maxSummaryWhyLen {
		return line
	}
	// Prefer breaking at a space so the cut doesn't land mid-word.
	cut := line[:maxSummaryWhyLen]
	if i := strings.LastIndexByte(cut, ' '); i > maxSummaryWhyLen/2 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " ,;:-") + "..."
}

// firstLine is the leading line of s.
func firstLine(s string) string {
	head, _, _ := strings.Cut(s, "\n")
	return strings.TrimSpace(head)
}

// hostRunCommandText renders the argv left after `--` as the single shell script
// the daemon runs (with `bash -lc`) and the approval card shows. That one string
// is both what the user reads and what executes, so it has to be a FAITHFUL
// rendering of the argv - a naive strings.Join dropped the shell quoting the
// agent's own shell had already consumed, turning
//
//	host-run -- bash -c "echo one; echo two"
//
// into `bash -c echo one; echo two`, which reads as nonsense and, worse, runs
// something else entirely (bash -c gets only `echo one`). Three rules:
//
//   - A lone argument is passed through verbatim: it is already a script, and
//     quoting it would run it as a command whose name is the whole string.
//   - `bash -c <script>` (or `-lc`, or a full path to bash) is unwrapped to just
//     the script - the daemon already runs it through `bash -lc`, so the wrapper
//     is redundant noise in the card.
//   - Anything else is quoted argv-faithfully, so a word carrying spaces or shell
//     metacharacters survives as one word instead of splitting apart.
func hostRunCommandText(args []string) string {
	if script, ok := unwrapBashDashC(args); ok {
		return strings.TrimSpace(script)
	}
	if len(args) == 1 {
		return strings.TrimSpace(args[0])
	}
	quoted := make([]string, 0, len(args))
	for _, a := range args {
		quoted = append(quoted, shellQuote(a))
	}
	return strings.TrimSpace(strings.Join(quoted, " "))
}

// unwrapBashDashC recognises the exact `bash -c <script>` shape (nothing after
// the script, since trailing words become $0/$1... and would change meaning) and
// returns the script. Only bash is unwrapped - re-running an `sh -c` script under
// bash could change its dialect, so that wrapper is left intact and quoted.
func unwrapBashDashC(args []string) (string, bool) {
	if len(args) != 3 {
		return "", false
	}
	switch args[0] {
	case "bash", "/bin/bash", "/usr/bin/bash":
	default:
		return "", false
	}
	switch args[1] {
	case "-c", "-lc", "-cl":
	default:
		return "", false
	}
	return args[2], true
}

// shellSafeWord matches a word that needs no quoting: it survives `bash -lc`
// unchanged and reads better bare.
var shellSafeWord = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

// shellQuote renders one argv word as bash source text.
func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	if shellSafeWord.MatchString(s) {
		return s
	}
	// Single quotes take everything literally; a literal `'` is spliced in as
	// '\'' (close, escaped quote, reopen).
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
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
