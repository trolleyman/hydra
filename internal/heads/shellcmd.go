package heads

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/egress"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

// ShellCommandResult is the outcome of a one-off `!command` a user ran from the
// chat composer: the combined stdout+stderr (ANSI preserved so the UI can colour
// it), the process exit code, and whether Output was capped.
type ShellCommandResult struct {
	Command   string `json:"command"`
	Output    string `json:"output"`
	ExitCode  int    `json:"exit_code"`
	Truncated bool   `json:"truncated"`
	// DurationMs is the wall-clock run time; TimedOut is set when the command was
	// killed for exceeding shellCommandTimeout (ExitCode is then -1). Stopped is
	// set when the user cancelled it mid-run (via a shell_stop frame).
	DurationMs int64 `json:"duration_ms"`
	TimedOut   bool  `json:"timed_out,omitempty"`
	Stopped    bool  `json:"stopped,omitempty"`
}

// ShellCommandTimeout bounds a chat `!command`. A user-typed inspection command
// (git status, ls, npm test) should be quick; a runaway one must not hold the
// sandbox open forever. Generous enough for a real test/build the user chose to
// run inline, short enough that a hung command self-recovers.
const ShellCommandTimeout = 10 * time.Minute

// shellCommandMaxOutput caps how much combined output one `!command` keeps (the
// TAIL - the end of a long log is what matters). The whole thing is also
// delivered to the agent as a user turn, so an unbounded dump would blow its
// context; the UI shows a "[... truncated ...]" note when this trips.
const shellCommandMaxOutput = 64 * 1024

// RunShellCommand runs `bash -c <command>` inside a head's sandbox (worktree as
// cwd, same writable/masked/network policy the agent runs under), capturing the
// combined stdout+stderr and exit code. It mirrors tests.buildCommandSpec but is
// deliberately self-contained: no HYDRA_TEST_* env, no marker parsing, just the
// output. Unknown network hosts are silently denied (like a test run) - a chat
// command must not park the sandbox waiting on a human egress approval.
//
// onChunk, if non-nil, is called with each chunk of combined output as it
// arrives (for live streaming to the UI). Because Stdout and Stderr point at the
// same writer, os/exec funnels both through one copy goroutine, so onChunk is
// invoked serially and in order - no interleaving races.
func RunShellCommand(ctx context.Context, projectRoot, worktree, sessionID string, agentType sandbox.AgentType, command string, onChunk func(string)) (ShellCommandResult, error) {
	res := ShellCommandResult{Command: command, ExitCode: -1}
	if strings.TrimSpace(command) == "" {
		return res, errtrace.Errorf("empty command")
	}
	if worktree == "" {
		return res, errtrace.Errorf("head has no worktree")
	}

	runCtx, cancel := context.WithTimeout(ctx, ShellCommandTimeout)
	defer cancel()

	launch, cleanup, err := buildShellCommandSpec(projectRoot, worktree, sessionID, agentType, command)
	if err != nil {
		return res, errtrace.Wrap(err)
	}
	defer cleanup()

	cmd := exec.CommandContext(runCtx, launch.Path, launch.Args[1:]...)
	cmd.Dir = launch.Dir
	cmd.Env = launch.Env
	cmd.ExtraFiles = launch.ExtraFiles
	// Combine stdout+stderr into one interleaved buffer - the user wants to see
	// exactly what the command printed, in order, like a terminal.
	var buf capBuffer
	buf.max = shellCommandMaxOutput
	if onChunk != nil {
		buf.onChunk = func(b []byte) { onChunk(string(b)) }
	}
	cmd.Stdout = &buf
	cmd.Stderr = &buf

	start := time.Now()
	runErr := cmd.Run()
	res.DurationMs = time.Since(start).Milliseconds()
	res.Output = buf.String()
	res.Truncated = buf.truncated

	if runCtx.Err() == context.DeadlineExceeded {
		res.TimedOut = true
		return res, nil
	}
	// A cancel from the caller (a shell_stop frame): the user killed it. Report it
	// as stopped, keeping whatever output ran so far.
	if errors.Is(runCtx.Err(), context.Canceled) {
		res.Stopped = true
		return res, nil
	}
	if runErr == nil {
		res.ExitCode = 0
		return res, nil
	}
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		res.ExitCode = exitErr.ExitCode()
		return res, nil
	}
	// Couldn't launch the command at all (spawn failure): surface it as an error
	// rather than a bogus exit code.
	return res, errtrace.Wrap(runErr)
}

// capBuffer is a bytes.Buffer that keeps only the last max bytes written, so a
// command that spews megabytes can't exhaust memory. It records whether any
// bytes were dropped so the caller can flag the output as truncated. onChunk, if
// set, sees every write verbatim (before capping) - the live stream, which the
// UI bounds on its own side.
type capBuffer struct {
	buf       bytes.Buffer
	max       int
	truncated bool
	onChunk   func([]byte)
}

func (c *capBuffer) Write(p []byte) (int, error) {
	if c.onChunk != nil {
		c.onChunk(p)
	}
	n := len(p)
	if c.max > 0 && c.buf.Len()+n > c.max {
		// Keep the tail: append then drop the oldest bytes down to max.
		c.buf.Write(p)
		if over := c.buf.Len() - c.max; over > 0 {
			tail := append([]byte(nil), c.buf.Bytes()[over:]...)
			c.buf.Reset()
			c.buf.Write(tail)
			c.truncated = true
		}
		return n, nil
	}
	return errtrace.Wrap2(c.buf.Write(p))
}

func (c *capBuffer) String() string { return c.buf.String() }

// buildShellCommandSpec resolves the sandbox launch spec for a chat `!command`.
// Returns the spec plus a cleanup closure (bwrap tmp + egress session + cow
// layer) the caller must defer. Mirrors tests.buildCommandSpec / the artifacts
// runner, minus their per-feature env contract.
func buildShellCommandSpec(projectRoot, worktree, sessionID string, agentType sandbox.AgentType, command string) (*sandbox.Spec, func(), error) {
	home, _ := os.UserHomeDir()
	cfg, _ := config.Load(projectRoot)
	env := agentEnv(agentType, cfg.ResolveInheritedEnv(string(agentType)), home, "", readGitConfigVal(projectRoot, "user.name"), readGitConfigVal(projectRoot, "user.email"))
	env = append(env, sandbox.MiseTrustEnv(projectRoot, worktree)...)
	env = append(env, readPreSpawnEnv(sandbox.HostPreSpawnEnvFile(ensureHeadTmpDir(projectRoot, sessionID)))...)

	opts := sandbox.Options{
		AgentType:    sandbox.AgentTypeBash,
		WorktreePath: worktree,
		Home:         home,
		Env:          env,
		Argv:         []string{"bash", "-c", command},
	}

	writable, readable, masked, cow, netPol, _ := cfg.ResolveSandboxOptions("")
	cfg.ApplySharedCaches(&opts, projectRoot, "", true)
	if gcd, err := git.GetCommonDir(projectRoot); err == nil {
		opts.GitCommonDir = gcd
	}
	opts.WritablePaths = writable
	opts.ReadablePaths = readable
	opts.MaskedPaths = sandbox.ResolveMaskedPaths(projectRoot, worktree, masked)

	var cowLayerDir string
	if len(cow) > 0 {
		cowDir := filepath.Join(paths.GetProjectStateDirFromProjectRoot(projectRoot), "cow")
		_ = os.MkdirAll(cowDir, 0o755)
		if base, err := os.MkdirTemp(cowDir, "shellcmd-"); err == nil {
			cowLayerDir = base
			opts.CowMounts = sandbox.ResolveCowMounts(projectRoot, worktree, home, base, cow, true)
		}
	}

	// Honor the project's network mode exactly like a test/agent run. Unknown
	// hosts are silently denied (nil approve): a chat command must not park the
	// sandbox waiting on a human egress-approval card.
	egressSess := egress.StartCommandEgress("shell:"+filepath.Base(worktree), sandbox.AgentTypeBash, &netPol, 0, nil)
	opts.Env = append(opts.Env, egressSess.Env...)
	opts.EgressWrap = egressSess.Wrap
	opts.Network = netPol
	opts.HardenGUI = true
	opts.Seccomp = true

	launch, err := sandbox.BuildSpec(opts)
	if err != nil {
		if cowLayerDir != "" {
			_ = os.RemoveAll(cowLayerDir)
		}
		egressSess.Close()
		return nil, func() {}, errtrace.Wrap(err)
	}
	cleanup := func() {
		if launch.Cleanup != nil {
			launch.Cleanup()
		}
		if cowLayerDir != "" {
			_ = os.RemoveAll(cowLayerDir)
		}
		egressSess.Close()
	}
	return launch, cleanup, nil
}
