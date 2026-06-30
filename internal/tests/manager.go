package tests

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

const (
	defaultTimeout = 10 * time.Minute // test suites run longer than artifact renders
	maxLogLines    = 5000
	reportFile     = "report.json"
	logFile        = "build.log"
)

// ProgressMarker prefixes a stdout line a test command emits to set the live
// progress header explicitly (e.g. `echo "::hydra:progress:: 84/142"`). Until the
// first marker, the latest stdout line is used. Matches artifacts.ProgressMarker.
const ProgressMarker = artifacts.ProgressMarker

// Manager owns test generation, caching, locking, and live-progress for a
// project. It mirrors artifacts.Manager (and reuses its slot pool + scheduler),
// differing only in the post-run parse step and the persisted result type.
type Manager struct {
	projectRoot string

	// onSettle, if set, is called (with projectRoot) after a generation finishes,
	// so the server can push an agents_changed event and refresh the sidebar/header
	// verdict chips immediately instead of waiting on the slow fallback poll. Set
	// once by the Registry at creation; read-only thereafter.
	onSettle func(projectRoot string)

	mu         sync.Mutex
	gens       map[string]struct{}
	progress   map[string]string
	startedAt  map[string]int64
	logs       map[string][]LogLine
	markerSeen map[string]bool
	cancel     map[string]context.CancelFunc
	fgWant     map[string]bool
	subs       map[int]chan Event
	nextSub    int

	sched *artifacts.GenScheduler
	pool  *artifacts.SlotPool
}

// NewManager creates a Manager for projectRoot, sized to the project's
// test_concurrency.
func NewManager(projectRoot string) *Manager {
	concurrency := config.DefaultTestConcurrency
	if cfg, err := config.Load(projectRoot); err == nil {
		concurrency = cfg.ResolveTestConcurrency()
	}
	m := &Manager{
		projectRoot: projectRoot,
		gens:        map[string]struct{}{},
		progress:    map[string]string{},
		startedAt:   map[string]int64{},
		logs:        map[string][]LogLine{},
		markerSeen:  map[string]bool{},
		cancel:      map[string]context.CancelFunc{},
		fgWant:      map[string]bool{},
		subs:        map[int]chan Event{},
		sched:       artifacts.NewGenScheduler(concurrency),
	}
	m.pool = artifacts.NewSlotPool(projectRoot, m.slotsDir(), artifacts.SlotsForConcurrency(concurrency))
	_ = paths.CreateGitignoreAllInDir(m.root())
	return m
}

// SetConcurrency resizes the scheduler + slot pool from a config change.
func (m *Manager) SetConcurrency(n int) {
	if n < 0 {
		n = 0
	}
	m.sched.SetLimit(n)
	m.pool.SetMaxSlots(artifacts.SlotsForConcurrency(n))
}

// CleanCheckouts tears the slot pool down to empty (call on boot).
func (m *Manager) CleanCheckouts() { m.pool.Clean() }

// Subscribe registers a generation-event listener; the returned func unsubscribes.
func (m *Manager) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 512)
	m.mu.Lock()
	id := m.nextSub
	m.nextSub++
	m.subs[id] = ch
	m.mu.Unlock()
	return ch, func() {
		m.mu.Lock()
		if c, ok := m.subs[id]; ok {
			delete(m.subs, id)
			close(c)
		}
		m.mu.Unlock()
	}
}

func (m *Manager) broadcastLocked(ev Event) {
	for _, ch := range m.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

// EntryDir returns the on-disk cache directory for (runner, v).
func (m *Manager) EntryDir(runner string, v Version) (string, error) {
	key, _, err := m.versionKey(v)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return m.entryDir(runner, key), nil
}

// Registry lazily creates and caches one Manager per project root.
type Registry struct {
	mu       sync.Mutex
	mgrs     map[string]*Manager
	onSettle func(projectRoot string)
}

func NewRegistry() *Registry { return &Registry{mgrs: map[string]*Manager{}} }

// SetOnSettle registers a callback invoked (with the project root) whenever any
// Manager's generation settles. Wired to events.Hub.AgentsChanged so a finished
// test run instantly refreshes the agent list verdict chips. Call before serving;
// it applies to Managers created afterwards.
func (r *Registry) SetOnSettle(fn func(projectRoot string)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.onSettle = fn
}

func (r *Registry) Manager(projectRoot string) *Manager {
	r.mu.Lock()
	defer r.mu.Unlock()
	if m, ok := r.mgrs[projectRoot]; ok {
		return m
	}
	m := NewManager(projectRoot)
	m.onSettle = r.onSettle
	r.mgrs[projectRoot] = m
	return m
}

func (r *Registry) Snapshot() map[string]*Manager {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]*Manager, len(r.mgrs))
	maps.Copy(out, r.mgrs)
	return out
}

func (m *Manager) root() string     { return paths.GetTestsDirFromProjectRoot(m.projectRoot) }
func (m *Manager) outDir() string   { return filepath.Join(m.root(), "out") }
func (m *Manager) slotsDir() string { return filepath.Join(m.root(), "slots") }

func (m *Manager) entryDir(runner, key string) string {
	return filepath.Join(m.outDir(), sanitizeName(runner), filepath.FromSlash(key))
}

const (
	keyKindCommit   = "commit"
	keyKindWorktree = "worktree"
)

func (m *Manager) versionKey(v Version) (key, ref string, err error) {
	if v.WorktreeDir != "" {
		h, err := git.WorktreeStateHash(v.WorktreeDir)
		if err != nil {
			return "", "", errtrace.Wrap(err)
		}
		return keyKindWorktree + "/" + h, "working tree", nil
	}
	sha, err := git.ResolveRef(m.projectRoot, v.Ref)
	if err != nil {
		return "", "", errtrace.Wrap(err)
	}
	return keyKindCommit + "/" + sha, sha, nil
}

// Get returns the cache entry for (spec, v), starting a foreground generation if
// it is neither cached nor in flight. A returned Report with StatusRunning means
// poll again shortly.
func (m *Manager) Get(spec config.TestScript, v Version) (Report, error) {
	return m.get(spec, v, true)
}

// Prefetch starts a background generation (no foreground priority).
func (m *Manager) Prefetch(spec config.TestScript, v Version) (Report, error) {
	return m.get(spec, v, false)
}

// Peek returns the cached report for (runner, v) without starting a run, plus
// whether one exists. Used by the merge gate and the AgentResponse summary so
// reading a verdict never triggers work.
func (m *Manager) Peek(runner string, v Version) (Report, bool, error) {
	key, _, err := m.versionKey(v)
	if err != nil {
		return Report{}, false, errtrace.Wrap(err)
	}
	dir := m.entryDir(runner, key)
	m.mu.Lock()
	_, inFlight := m.gens[dir]
	started := m.startedAt[dir]
	prog := m.progress[dir]
	m.mu.Unlock()
	if inFlight {
		return Report{Runner: runner, Key: key, Status: StatusRunning, StartedAt: started, Progress: prog}, true, nil
	}
	rep, ok := readReport(dir)
	return rep, ok, nil
}

// Latest returns the most-recently-updated cached report for a runner across all
// commits, ignoring which version it was computed for. Used to detect a "stale"
// verdict (a cached result that predates the head's current commit) for the head
// summary chip. Returns (Report{}, false) when nothing is cached.
func (m *Manager) Latest(runner string) (Report, bool) {
	base := filepath.Join(m.outDir(), sanitizeName(runner))
	var best Report
	found := false
	// Layout: out/<runner>/<kind>/<id>/report.json
	_ = filepath.WalkDir(base, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Name() != reportFile {
			return nil
		}
		if rep, ok := readReport(filepath.Dir(path)); ok && rep.UpdatedAt >= best.UpdatedAt {
			best, found = rep, true
		}
		return nil
	})
	return best, found
}

func (m *Manager) get(spec config.TestScript, v Version, fg bool) (Report, error) {
	key, ref, err := m.versionKey(v)
	if err != nil {
		return Report{}, errtrace.Wrap(err)
	}
	dir := m.entryDir(spec.Name, key)

	m.mu.Lock()
	if rep, ok := readReport(dir); ok {
		m.mu.Unlock()
		return rep, nil
	}
	if _, inFlight := m.gens[dir]; inFlight {
		if fg {
			m.fgWant[dir] = true
		}
		prog := m.progress[dir]
		started := m.startedAt[dir]
		logCopy := append([]LogLine(nil), m.logs[dir]...)
		m.mu.Unlock()
		if fg {
			m.sched.Promote(dir)
		}
		return Report{Runner: spec.Name, Key: key, Ref: ref, Status: StatusRunning, Progress: prog, StartedAt: started, Log: logCopy}, nil
	}
	started := time.Now().Unix()
	genCtx, genCancel := context.WithCancel(context.Background())
	m.gens[dir] = struct{}{}
	m.startedAt[dir] = started
	m.logs[dir] = nil
	m.cancel[dir] = genCancel
	if fg {
		m.fgWant[dir] = true
	}
	m.mu.Unlock()

	go func() {
		defer genCancel()
		m.sched.Acquire(dir, fg)
		defer m.sched.Release()

		rep := m.generate(genCtx, spec, v, key, ref)
		cancelled := genCtx.Err() != nil
		if cancelled {
			_ = os.RemoveAll(dir)
		} else if err := writeReport(dir, rep); err != nil {
			_ = err
		}
		m.mu.Lock()
		logCopy := append([]LogLine(nil), m.logs[dir]...)
		delete(m.gens, dir)
		delete(m.progress, dir)
		delete(m.startedAt, dir)
		delete(m.logs, dir)
		delete(m.markerSeen, dir)
		delete(m.cancel, dir)
		delete(m.fgWant, dir)
		m.broadcastLocked(Event{Dir: dir, Kind: "settled"})
		m.mu.Unlock()
		if !cancelled {
			writeLogFile(dir, logCopy)
		}
		// Nudge web clients to refetch the agent list now that this run's verdict is
		// final, so the sidebar/header chips flip from "running" instantly rather
		// than lagging until the 30s fallback poll. Coalesced by the events hub, so
		// firing on every settle (including background prefetches) is cheap.
		if m.onSettle != nil {
			m.onSettle(m.projectRoot)
		}
	}()

	return Report{Runner: spec.Name, Key: key, Ref: ref, Status: StatusRunning, StartedAt: started}, nil
}

// Invalidate drops the cached entry so the next Get regenerates it. No-op while a
// generation is in flight.
func (m *Manager) Invalidate(runner string, v Version) error {
	key, _, err := m.versionKey(v)
	if err != nil {
		return errtrace.Wrap(err)
	}
	dir := m.entryDir(runner, key)
	m.mu.Lock()
	_, inFlight := m.gens[dir]
	m.mu.Unlock()
	if inFlight {
		return nil
	}
	return errtrace.Wrap(os.RemoveAll(dir))
}

// CancelStaleBackground cancels the in-flight generation at dir if no foreground
// viewer has claimed it.
func (m *Manager) CancelStaleBackground(dir string) {
	m.mu.Lock()
	cancel := m.cancel[dir]
	fgWant := m.fgWant[dir]
	m.mu.Unlock()
	if cancel != nil && !fgWant {
		cancel()
	}
}

func (m *Manager) appendLog(dir, text, stream string, isMarker bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, inFlight := m.gens[dir]; !inFlight {
		return
	}
	line := LogLine{Text: text, Stream: stream}
	m.logs[dir] = append(m.logs[dir], line)
	if over := len(m.logs[dir]) - maxLogLines; over > 0 {
		m.logs[dir] = m.logs[dir][over:]
	}
	m.broadcastLocked(Event{Dir: dir, Kind: "log", Line: line})
	switch {
	case isMarker:
		m.markerSeen[dir] = true
		m.setProgressLocked(dir, text)
	case stream == StreamStdout && !m.markerSeen[dir]:
		m.setProgressLocked(dir, text)
	}
}

func (m *Manager) setProgressLocked(dir, text string) {
	if m.progress[dir] == text {
		return
	}
	m.progress[dir] = text
	m.broadcastLocked(Event{Dir: dir, Kind: "progress", Progress: text})
}

// generate runs the command for one version and returns the resulting Report.
func (m *Manager) generate(parent context.Context, spec config.TestScript, v Version, key, ref string) Report {
	rep := Report{Runner: spec.Name, Key: key, Ref: ref, UpdatedAt: time.Now().Unix()}

	_ = paths.CreateGitignoreAllInDir(m.root())
	dir := m.entryDir(spec.Name, key)
	outputDir := filepath.Join(dir, "output")
	if err := os.RemoveAll(dir); err != nil {
		return errored(rep, err.Error())
	}
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return errored(rep, err.Error())
	}

	runDir := v.WorktreeDir
	if runDir == "" {
		s, err := m.pool.Acquire(ref, spec.CleanIgnored)
		if err != nil {
			return errored(rep, fmt.Sprintf("checkout %s: %v", ref, err))
		}
		defer m.pool.Release(s)
		runDir = s.Path()
	}

	timeout := defaultTimeout
	if spec.TimeoutSec > 0 {
		timeout = time.Duration(spec.TimeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	launch, err := m.buildCommandSpec(spec, runDir, outputDir, ref)
	if err != nil {
		return errored(rep, err.Error())
	}
	defer launch.Cleanup()

	cmd := exec.CommandContext(ctx, launch.Path, launch.Args[1:]...) //errtrace:skip
	cmd.Dir = launch.Dir
	cmd.Env = launch.Env
	cmd.ExtraFiles = launch.ExtraFiles
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return errored(rep, err.Error())
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return errored(rep, err.Error())
	}
	start := time.Now()
	if err := cmd.Start(); err != nil {
		// Couldn't even launch the command — an infrastructure failure, not a
		// test result.
		return errored(rep, err.Error())
	}
	var stderrBuf bytes.Buffer
	var stderrMu sync.Mutex
	scan := func(r io.Reader, stream string) {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := strings.TrimRight(sc.Text(), "\r")
			if stream == StreamStderr {
				stderrMu.Lock()
				stderrBuf.WriteString(line)
				stderrBuf.WriteByte('\n')
				stderrMu.Unlock()
			}
			if stream == StreamStdout {
				if rest, ok := strings.CutPrefix(strings.TrimSpace(line), ProgressMarker); ok {
					if text := strings.TrimSpace(rest); text != "" {
						m.appendLog(dir, text, stream, true)
					}
					continue
				}
			}
			if strings.TrimSpace(line) != "" {
				m.appendLog(dir, line, stream, false)
			}
		}
		_ = sc.Err()
	}
	var scanWG sync.WaitGroup
	scanWG.Go(func() { scan(stdout, StreamStdout) })
	scanWG.Go(func() { scan(stderrPipe, StreamStderr) })
	runErr := cmd.Wait()
	scanWG.Wait()
	durationMs := time.Since(start).Milliseconds()

	// A timeout means we have no trustworthy verdict.
	if ctx.Err() == context.DeadlineExceeded {
		rep.DurationMs = durationMs
		return errored(rep, "timed out after "+timeout.String())
	}

	cases, format, found, perr := ParseDir(outputDir)
	if perr != nil {
		rep.DurationMs = durationMs
		return errored(rep, "read report: "+perr.Error())
	}

	rep.DurationMs = durationMs
	rep.Format = format
	if found {
		// A parsed report is authoritative: a runner that exits non-zero because
		// tests failed is a valid failing verdict, not an error.
		rep.Cases = cases
		rep.Passed, rep.Failed, rep.Skipped = Summarize(cases)
		rep.Total = rep.Passed + rep.Failed + rep.Skipped
		if rep.Failed > 0 {
			rep.Status = StatusFailing
		} else {
			rep.Status = StatusPassing
		}
		rep.UpdatedAt = time.Now().Unix()
		return rep
	}

	// No report file: fall back to a degenerate verdict from the exit code so a
	// non-instrumented command still shows red/green.
	rep.Format = "exit"
	stderrMu.Lock()
	tail := strings.TrimSpace(stderrBuf.String())
	stderrMu.Unlock()
	rep.UpdatedAt = time.Now().Unix()
	if runErr == nil {
		rep.Status = StatusPassing
		rep.Cases = []TestCase{{Name: "(command exited 0)", Status: CasePassed, DurationMs: durationMs}}
		rep.Passed, rep.Total = 1, 1
		return rep
	}
	var exitErr *exec.ExitError
	if errors.As(runErr, &exitErr) {
		// It ran and exited non-zero with no report — treat the exit code as the
		// test result (degenerate single failed case).
		msg := "command exited non-zero"
		if tail != "" {
			msg = lastLines(tail, 15)
		}
		rep.Status = StatusFailing
		rep.Cases = []TestCase{{Name: "(command exited non-zero)", Status: CaseFailed, DurationMs: durationMs, Message: truncate(msg, maxCaseMessage)}}
		rep.Failed, rep.Total = 1, 1
		return rep
	}
	// Anything else (couldn't wait, killed by signal) is an error, not a verdict.
	msg := runErr.Error()
	if tail != "" {
		msg += ": " + lastLines(tail, 15)
	}
	return errored(rep, msg)
}

func errored(rep Report, msg string) Report {
	rep.Status = StatusErrored
	rep.Error = msg
	rep.UpdatedAt = time.Now().Unix()
	return rep
}

// buildCommandSpec resolves the test command into a sandboxed launch spec,
// mirroring artifacts.buildCommandSpec but with the HYDRA_TEST_* env contract.
func (m *Manager) buildCommandSpec(spec config.TestScript, runDir, outputDir, ref string) (*sandbox.Spec, error) {
	home, _ := os.UserHomeDir()

	env := append([]string{}, os.Environ()...)
	if home != "" {
		env = append(env, "HOME="+home)
	}
	env = append(env,
		"HYDRA_TEST_OUTPUT="+outputDir,
		"HYDRA_TEST_SOURCE="+runDir,
		"HYDRA_TEST_REF="+ref,
	)
	env = append(env, sandbox.MiseTrustEnv(m.projectRoot, runDir)...)

	command := spec.Command
	if spec.IsStrict() {
		command = sandbox.StrictScript(spec.Command)
	}
	opts := sandbox.Options{
		AgentType:    sandbox.AgentTypeBash,
		WorktreePath: runDir,
		Home:         home,
		Env:          env,
		Argv:         []string{"bash", "-c", command},
		NoSandbox:    spec.UnsafeHost,
	}

	if !spec.UnsafeHost {
		cfg, _ := config.Load(m.projectRoot)
		writable, masked, restore, _, _, _ := cfg.ResolveSandboxOptions("")
		writable = append(writable, outputDir)
		if gcd, err := git.GetCommonDir(m.projectRoot); err == nil {
			opts.GitCommonDir = gcd
		}
		opts.WritablePaths = writable
		opts.MaskedPaths = masked
		opts.RestoreRO = restore
		opts.Network = sandbox.NetworkPolicy{Enabled: true}
		opts.HardenGUI = true
		opts.Seccomp = true
	}

	return errtrace.Wrap2(sandbox.BuildSpec(opts))
}

// --- persistence ---

func readReport(dir string) (Report, bool) {
	data, err := os.ReadFile(filepath.Join(dir, reportFile))
	if err != nil {
		return Report{}, false
	}
	var rep Report
	if err := json.Unmarshal(data, &rep); err != nil {
		return Report{}, false
	}
	if rep.Status == "" {
		return Report{}, false
	}
	return rep, true
}

func writeReport(dir string, rep Report) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	data, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(filepath.Join(dir, reportFile), data, 0o644))
}

func writeLogFile(dir string, lines []LogLine) {
	if len(lines) == 0 {
		return
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for _, l := range lines {
		if err := enc.Encode(l); err != nil {
			return
		}
	}
	_ = os.WriteFile(filepath.Join(dir, logFile), buf.Bytes(), 0o644)
}

var keyRe = regexp.MustCompile(`^(commit|worktree)/[0-9a-f]+$`)

// HasLog reports whether a persisted build log exists for a settled entry.
func (m *Manager) HasLog(runner, key string) bool {
	if !keyRe.MatchString(key) {
		return false
	}
	_, err := os.Stat(filepath.Join(m.entryDir(runner, key), logFile))
	return err == nil
}

// ReadLog returns the persisted build log for a settled entry.
func (m *Manager) ReadLog(runner, key string) ([]LogLine, bool) {
	if !keyRe.MatchString(key) {
		return nil, false
	}
	data, err := os.ReadFile(filepath.Join(m.entryDir(runner, key), logFile))
	if err != nil {
		return nil, false
	}
	var out []LogLine
	dec := json.NewDecoder(bytes.NewReader(data))
	for {
		var l LogLine
		if err := dec.Decode(&l); err != nil {
			break
		}
		out = append(out, l)
	}
	return out, true
}

var unsafeName = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func sanitizeName(name string) string {
	s := unsafeName.ReplaceAllString(strings.TrimSpace(name), "-")
	s = strings.Trim(s, "-")
	if s == "" {
		return "unnamed"
	}
	return s
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
