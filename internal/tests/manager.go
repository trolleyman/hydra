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
	"github.com/trolleyman/hydra/internal/egress"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

const (
	defaultTimeout  = 10 * time.Minute // test suites run longer than artifact renders
	maxLogLines     = 5000
	reportFile      = "report.json"
	logFile         = "build.log"
	branchTotalFile = "total.json" // per-branch denominator estimate (see recordBranchTotal)
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
	// onProgress, if set, is called (with projectRoot) while a streamed
	// (type=stdout) run is appending cases - throttled to testNudgeInterval per
	// run. Wired to Server.NotifyTestsProgress, which pushes per-head
	// agent_tests_changed payload events so the sidebar chip's live ✓/⚠/✗
	// counts tick during the run without clients refetching the agent list.
	// Same wiring discipline as onSettle.
	onProgress func(projectRoot string)

	mu         sync.Mutex
	gens       map[string]struct{}
	progress   map[string]string
	startedAt  map[string]int64
	logs       map[string][]LogLine
	markerSeen map[string]bool
	live       map[string]*liveRun
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
		live:        map[string]*liveRun{},
		cancel:      map[string]context.CancelFunc{},
		fgWant:      map[string]bool{},
		subs:        map[int]chan Event{},
		sched:       artifacts.NewGenScheduler(concurrency),
	}
	m.pool = artifacts.NewSlotPool(projectRoot, m.slotsDir(), artifacts.SlotsForConcurrency(concurrency))
	_ = paths.EnsureHydraLocalIgnored(m.root())
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

// CleanCheckouts tears the slot pool down to empty (call on boot) and wipes any
// ephemeral per-run cow_paths layers a crashed run left behind.
func (m *Manager) CleanCheckouts() {
	_ = os.RemoveAll(m.cowDir())
	m.pool.Clean()
}

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
	mu         sync.Mutex
	mgrs       map[string]*Manager
	onSettle   func(projectRoot string)
	onProgress func(projectRoot string)
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

// SetOnProgress registers a callback invoked (throttled per in-flight run)
// while a streamed run's counts tick. Wired to events.Hub.AgentsChanged so the
// sidebar chip counts live during a type=stdout run. Call before serving; it
// applies to Managers created afterwards.
func (r *Registry) SetOnProgress(fn func(projectRoot string)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.onProgress = fn
}

func (r *Registry) Manager(projectRoot string) *Manager {
	r.mu.Lock()
	defer r.mu.Unlock()
	if m, ok := r.mgrs[projectRoot]; ok {
		return m
	}
	m := NewManager(projectRoot)
	m.onSettle = r.onSettle
	m.onProgress = r.onProgress
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

// cowDir holds the per-run copy-on-write upper/work layers for cow_paths applied
// during a test run (see buildCommandSpec), mirroring artifacts. Each run gets an
// ephemeral subdir here, removed when its launch is cleaned up.
func (m *Manager) cowDir() string { return filepath.Join(m.root(), "cow") }

func (m *Manager) entryDir(runner, key string) string {
	return filepath.Join(m.outDir(), sanitizeName(runner), filepath.FromSlash(key))
}

// branchTotalDir is where a runner's per-branch total sidecar lives:
// out/<runner>/branch/<sanitized-branch>/. Kept beside the commit/worktree entry
// dirs but under its own kind so it never collides with a report.json entry (and
// Latest, which only reads report.json files, ignores it).
func (m *Manager) branchTotalDir(runner, branch string) string {
	return filepath.Join(m.outDir(), sanitizeName(runner), keyKindBranch, sanitizeName(branch))
}

const (
	keyKindCommit   = "commit"
	keyKindWorktree = "worktree"
	keyKindBranch   = "branch" // holds per-branch total.json sidecars, not report.json entries
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
	return errtrace.Wrap2(m.get(spec, v, true))
}

// Prefetch starts a background generation (no foreground priority).
func (m *Manager) Prefetch(spec config.TestScript, v Version) (Report, error) {
	return errtrace.Wrap2(m.get(spec, v, false))
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
	if _, inFlight := m.gens[dir]; inFlight {
		rep := Report{Runner: runner, Key: key, Status: StatusRunning, StartedAt: m.startedAt[dir], Progress: m.progress[dir]}
		m.fillRunningLocked(dir, &rep)
		m.mu.Unlock()
		return rep, true, nil
	}
	m.mu.Unlock()
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
		rep := Report{Runner: spec.Name, Key: key, Ref: ref, Status: StatusRunning, Progress: m.progress[dir], StartedAt: m.startedAt[dir], Log: append([]LogLine(nil), m.logs[dir]...)}
		m.fillRunningLocked(dir, &rep)
		m.mu.Unlock()
		if fg {
			m.sched.Promote(dir)
		}
		return rep, nil
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
		if !cancelled {
			// Attribute this run's case count to its branch so the next run of the
			// branch can estimate its denominator (see fallbackTotal). ref is the
			// resolved commit SHA for a commit run ("working tree" for a worktree
			// run, which recordBranchTotal ignores).
			m.recordBranchTotal(spec.Name, v, rep, ref)
		}
		m.mu.Lock()
		logCopy := append([]LogLine(nil), m.logs[dir]...)
		// Emit the final coalesced counts increment (a fast run can settle before
		// the flush timer ever fires) - it also stops any pending timer. The
		// settled event below then delivers the authoritative report anyway.
		m.flushCountsLocked(dir)
		delete(m.live, dir)
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

// --- streamed test markers (type = "stdout") ---

const (
	// caseFlushInterval / caseFlushMax coalesce "counts" events: an event fires
	// at most ~10×/s, or immediately once this many cases are pending - the
	// backpressure guard that keeps a 4,556-case run from emitting 4,556 frames.
	caseFlushInterval = 100 * time.Millisecond
	caseFlushMax      = 200
	// testNudgeInterval throttles the onProgress nudge: each one makes the
	// server recompute running heads' summaries and push agent_tests_changed
	// payload events, so the sidebar chip ticks ~every 2s, not at counts rate.
	testNudgeInterval = 2 * time.Second
)

// liveRun accumulates the streamed test cases of one in-flight generation.
// Guarded by Manager.mu.
type liveRun struct {
	cases                             []TestCase
	total                             int  // denominator (0 = unknown)
	totalEstimated                    bool // total is a carried-over estimate, not a declared ::hydra:test:total::
	passed, failed, skipped, warnings int
	pending                           []TestCase // appended since the last coalesced flush
	timer                             *time.Timer
	lastNudge                         time.Time // last onProgress nudge (see testNudgeInterval)
}

// appendTestCase records one streamed case: it feeds the accumulated report,
// the running tally, the live progress header ("123/4556" - which the agent
// list's summary also surfaces, so the sidebar chip ticks), and the coalesced
// "counts" event stream.
func (m *Manager) appendTestCase(dir string, tc TestCase) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, inFlight := m.gens[dir]; !inFlight {
		return
	}
	lr := m.live[dir]
	if lr == nil {
		lr = &liveRun{}
		m.live[dir] = lr
	}
	lr.cases = append(lr.cases, tc)
	lr.pending = append(lr.pending, tc)
	switch tc.Status {
	case CaseFailed:
		lr.failed++
	case CaseSkipped:
		lr.skipped++
	case CaseWarning:
		lr.warnings++
	default:
		lr.passed++
	}
	// Test markers are more specific than plain stdout lines, so they own the
	// progress header (like an explicit ::hydra:progress:: marker would).
	m.markerSeen[dir] = true
	m.setProgressLocked(dir, lr.progressText())
	if len(lr.pending) >= caseFlushMax {
		m.flushCountsLocked(dir)
	} else if lr.timer == nil {
		lr.timer = time.AfterFunc(caseFlushInterval, func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			m.flushCountsLocked(dir)
		})
	}
}

// setTestTotal records the declared ::hydra:test:total:: denominator.
func (m *Manager) setTestTotal(dir string, total int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, inFlight := m.gens[dir]; !inFlight {
		return
	}
	lr := m.live[dir]
	if lr == nil {
		lr = &liveRun{}
		m.live[dir] = lr
	}
	lr.total = total
	lr.totalEstimated = false // a real declared total supersedes any seeded estimate
	m.markerSeen[dir] = true
	m.setProgressLocked(dir, lr.progressText())
}

// seedEstimatedTotal seeds an in-flight streaming run's denominator with an
// estimate carried over from a prior run (see fallbackTotal), giving an
// un-instrumented run a determinate progress bar until - and unless - the runner
// declares its own ::hydra:test:total::. It never sets markerSeen (this isn't a
// real marker) and never overrides an already-set total, and marks the value
// estimated so the UI can render it as approximate.
func (m *Manager) seedEstimatedTotal(dir string, total int) {
	if total <= 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, inFlight := m.gens[dir]; !inFlight {
		return
	}
	lr := m.live[dir]
	if lr == nil {
		lr = &liveRun{}
		m.live[dir] = lr
	}
	if lr.total > 0 {
		return // a declared (or already-seeded) total wins
	}
	lr.total = total
	lr.totalEstimated = true
	m.setProgressLocked(dir, lr.progressText())
}

// fallbackTotal estimates a streaming denominator for a run that declares no
// ::hydra:test:total:: by reusing a prior run's case count. It walks the refs in
// priority order - typically the head's own branch, then its base branch - and
// for each ref tries, most-accurate first:
//
//  1. A cached commit report for the ref's current tip (a prior run of that
//     EXACT commit): strictly the right count when it exists, though it usually
//     won't - a commit is normally tested only once.
//  2. The per-branch total (recordBranchTotal): the last case count run against
//     that branch, keyed by branch name. Refreshed on every run of the branch,
//     so the head's own branch almost always has one - it just may be from a
//     slightly older commit, hence second to an exact commit match.
//
// As a last resort it uses the most-recently-updated cached report for the
// runner (Latest), mirroring the stale-verdict fallback. 0 = nothing usable.
func (m *Manager) fallbackTotal(runner string, refs []string) int {
	for _, ref := range refs {
		if ref == "" {
			continue
		}
		if sha, err := git.ResolveRef(m.projectRoot, ref); err == nil {
			if rep, ok := readReport(m.entryDir(runner, keyKindCommit+"/"+sha)); ok && rep.Total > 0 {
				return rep.Total
			}
		}
		if bt, ok := readBranchTotal(m.branchTotalDir(runner, ref)); ok && bt.Total > 0 {
			return bt.Total
		}
	}
	if rep, ok := m.Latest(runner); ok && rep.Total > 0 {
		return rep.Total
	}
	return 0
}

// recordBranchTotal saves a settled run's case count under its branch (v.Branch)
// so the next run of that branch can estimate its denominator (see
// fallbackTotal) even at a brand-new commit. Guards:
//
//   - A *commit* run is only attributed to the branch when it IS the branch's
//     current tip - an explicitly-selected old commit must not overwrite the
//     moving branch's total; a *worktree* run is the branch's own working
//     checkout, so it always counts.
//   - Recency wins over wall-clock: the stored total is kept when its commit is
//     closer to the branch head (a descendant of this run's commit). So an older
//     commit whose run happens to settle later can't clobber a newer commit's
//     total - closer-to-head is always the better estimate.
//   - Degenerate verdicts (the exit-code fallback, errored runs, empty reports)
//     are never recorded - only a real parsed report with cases.
func (m *Manager) recordBranchTotal(runner string, v Version, rep Report, runSHA string) {
	if v.Branch == "" || rep.Total <= 0 {
		return
	}
	if rep.Status != StatusPassing && rep.Status != StatusFailing {
		return
	}
	if rep.Format == "" || rep.Format == "exit" {
		return // exit-code fallback (Total==1) isn't a real case count
	}
	tip, err := git.ResolveRef(m.projectRoot, v.Branch)
	if err != nil {
		return
	}
	if v.WorktreeDir == "" && runSHA != tip {
		return // an old/explicit commit - don't attribute it to the branch tip
	}
	dir := m.branchTotalDir(runner, v.Branch)
	// Keep a stored total whose commit is closer to head (descends from this
	// run's tip). Unrelated lineages (e.g. after a rebase) fall through and the
	// current tip wins, since it's the branch's live state.
	if prev, ok := readBranchTotal(dir); ok && prev.Ref != "" && prev.Ref != tip {
		if newer, aerr := git.IsAncestor(m.projectRoot, tip, prev.Ref); aerr == nil && newer {
			return
		}
	}
	_ = writeBranchTotal(dir, branchTotal{Total: rep.Total, Ref: tip, UpdatedAt: time.Now().Unix()})
}

// declaredTotal is the ::hydra:test:total:: denominator, floored at the cases
// seen so far: a runner can only declare what it knows upfront (Go subtests
// aren't listable), so an overshooting count grows the denominator instead of
// rendering "130/121". 0 = no total declared.
func (lr *liveRun) declaredTotal() int {
	if lr.total <= 0 {
		return 0
	}
	return max(lr.total, len(lr.cases))
}

func (lr *liveRun) progressText() string {
	if total := lr.declaredTotal(); total > 0 {
		return fmt.Sprintf("%d/%d", len(lr.cases), total)
	}
	return fmt.Sprintf("%d", len(lr.cases))
}

// flushCountsLocked emits one coalesced "counts" event carrying the running
// totals plus the cases appended since the previous flush. No-op when nothing
// is pending or the run already settled (m.live cleaned up).
func (m *Manager) flushCountsLocked(dir string) {
	lr := m.live[dir]
	if lr == nil {
		return
	}
	if lr.timer != nil {
		lr.timer.Stop()
		lr.timer = nil
	}
	if len(lr.pending) == 0 {
		return
	}
	counts := &RunningCounts{
		Passed: lr.passed, Failed: lr.failed, Skipped: lr.skipped, Warnings: lr.warnings,
		Total:          lr.declaredTotal(),
		TotalEstimated: lr.totalEstimated,
		Cases:          lr.pending,
	}
	lr.pending = nil
	m.broadcastLocked(Event{Dir: dir, Kind: "counts", Counts: counts})
	// Nudge the server (throttled) to push updated per-head summaries so the
	// sidebar chip's live counts tick during the run - the settle nudge covers
	// the final state. Fired async so the callback never runs under m.mu.
	if m.onProgress != nil && time.Since(lr.lastNudge) >= testNudgeInterval {
		lr.lastNudge = time.Now()
		go m.onProgress(m.projectRoot)
	}
}

// fillRunningLocked copies the in-flight streamed state into a running Report
// snapshot, so a late subscriber (or the polling fallback) sees the partial
// case list and tallies instead of an empty card.
func (m *Manager) fillRunningLocked(dir string, rep *Report) {
	lr := m.live[dir]
	if lr == nil {
		return
	}
	rep.Cases = append([]TestCase(nil), lr.cases...)
	rep.Passed, rep.Failed, rep.Skipped, rep.Warnings = lr.passed, lr.failed, lr.skipped, lr.warnings
	// Mirror the streamed "counts" event (flushCountsLocked): a running snapshot's
	// Total is the *declared* denominator, or 0 when none was declared - NOT floored
	// to len(cases). Reporting len(cases) here made an undeclared run indistinguishable
	// from a declared one whose cases had caught up (both total == cases), so the poll
	// fallback couldn't tell "no denominator" from "denominator reached". 0 = unknown.
	rep.Total = lr.declaredTotal()
	rep.TotalEstimated = lr.totalEstimated
}

// liveCases returns a copy of the streamed cases accumulated so far.
func (m *Manager) liveCases(dir string) []TestCase {
	m.mu.Lock()
	defer m.mu.Unlock()
	lr := m.live[dir]
	if lr == nil {
		return nil
	}
	return append([]TestCase(nil), lr.cases...)
}

// generate runs the command for one version and returns the resulting Report.
func (m *Manager) generate(parent context.Context, spec config.TestScript, v Version, key, ref string) Report {
	rep := Report{Runner: spec.Name, Key: key, Ref: ref, UpdatedAt: time.Now().Unix()}

	_ = paths.EnsureHydraLocalIgnored(m.root())
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

	// A streaming run that never declares ::hydra:test:total:: still gets a
	// determinate progress bar: seed the denominator from a prior run's total
	// (this branch, else the base branch, else the latest anywhere). A real
	// marker later supersedes it (setTestTotal clears the estimate). Computed
	// BEFORE the command starts so its git/cache lookups never sit between
	// cmd.Start and the stdout scanner (delaying reads risks a full pipe buffer).
	if spec.IsStreaming() {
		if est := m.fallbackTotal(spec.Name, v.TotalHintRefs); est > 0 {
			m.seedEstimatedTotal(dir, est)
		}
	}

	cmd := exec.CommandContext(ctx, launch.Path, launch.Args[1:]...)
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
		// Couldn't even launch the command - an infrastructure failure, not a
		// test result.
		return errored(rep, err.Error())
	}
	var stderrBuf bytes.Buffer
	var stderrMu sync.Mutex
	lc := newLocContext(runDir)
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
				// ::hydra:test:*:: markers are protocol, not log output: they feed
				// the live case accumulation + coalesced counts events, and are kept
				// out of the log ring so a 4,556-case run doesn't flood the WS with
				// one log frame per test.
				if mk, ok := parseTestMarker(line, lc); ok {
					switch mk.kind {
					case "case":
						m.appendTestCase(dir, mk.c)
					case "total":
						m.setTestTotal(dir, mk.total)
					}
					continue
				}
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
	// Drain both pipes to EOF BEFORE Wait: cmd.Wait closes the StdoutPipe/StderrPipe
	// once the process exits, so calling it before reads finish can truncate the
	// output (and drop trailing ::hydra:test:*:: markers). See the StdoutPipe docs.
	scanWG.Wait()
	runErr := cmd.Wait()
	durationMs := time.Since(start).Milliseconds()

	// A timeout means we have no trustworthy verdict.
	if ctx.Err() == context.DeadlineExceeded {
		rep.DurationMs = durationMs
		return errored(rep, "timed out after "+timeout.String())
	}

	var cases []TestCase
	var format string
	var found bool
	if spec.IsStreaming() {
		// type = "stdout": the accumulated ::hydra:test:*:: cases ARE the report;
		// no file is read. Zero markers falls through to the exit-code verdict.
		cases = m.liveCases(dir)
		format = "stdout"
		found = len(cases) > 0
	} else {
		var perr error
		cases, format, found, perr = ParseDir(outputDir, runDir)
		if perr != nil {
			rep.DurationMs = durationMs
			return errored(rep, "read report: "+perr.Error())
		}
	}

	rep.DurationMs = durationMs
	rep.Format = format
	if found {
		// A parsed report is authoritative: a runner that exits non-zero because
		// tests failed is a valid failing verdict, not an error.
		rep.Cases = cases
		rep.Passed, rep.Failed, rep.Skipped, rep.Warnings = Summarize(cases)
		rep.Total = rep.Passed + rep.Failed + rep.Skipped + rep.Warnings
		// Warnings are informational: they never flip the verdict to failing.
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
		// It ran and exited non-zero with no report - treat the exit code as the
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

	var cowLayerDir string
	var egressSess *egress.Session
	if !spec.UnsafeHost {
		cfg, _ := config.Load(m.projectRoot)
		writable, masked, restore, cow, netPol, _ := cfg.ResolveSandboxOptions("")
		writable = append(writable, outputDir)
		if gcd, err := git.GetCommonDir(m.projectRoot); err == nil {
			opts.GitCommonDir = gcd
		}
		opts.WritablePaths = writable
		opts.MaskedPaths = masked
		opts.RestoreRO = restore
		// Apply cow_paths so a shared host cache the project isolates per-head
		// (e.g. ~/.gradle) is writable for the test run too - otherwise a
		// Gradle-based suite runs with it READ-ONLY and can't write its lock/build
		// outputs. Per-run ephemeral upper over the shared read-only lower (warm
		// deps reused, no cross-run upperdir sharing), removed on launch cleanup.
		// Mirrors artifacts.buildCommandSpec.
		if len(cow) > 0 {
			_ = os.MkdirAll(m.cowDir(), 0o755)
			if base, err := os.MkdirTemp(m.cowDir(), "run-"); err == nil {
				cowLayerDir = base
				opts.CowMounts = sandbox.ResolveCowMounts(m.projectRoot, runDir, home, base, cow, true)
			}
		}
		// Test runs honor the project's network mode like agent heads do (hard =
		// pasta netns + nft + CONNECT proxy); the session dies with the launch
		// cleanup below. Unknown hosts are silently denied - a suite must not
		// park waiting for a human approval.
		egressSess = egress.StartCommandEgress("tests:"+spec.Name, sandbox.AgentTypeBash, &netPol, 0, nil)
		opts.Env = append(opts.Env, egressSess.Env...)
		opts.EgressWrap = egressSess.Wrap
		opts.Network = netPol
		opts.HardenGUI = true
		opts.Seccomp = true
	}

	launch, err := sandbox.BuildSpec(opts)
	if err != nil {
		if cowLayerDir != "" {
			_ = os.RemoveAll(cowLayerDir)
		}
		egressSess.Close()
		return nil, errtrace.Wrap(err)
	}
	if cowLayerDir != "" || egressSess != nil {
		inner := launch.Cleanup
		launch.Cleanup = func() {
			if inner != nil {
				inner()
			}
			if cowLayerDir != "" {
				_ = os.RemoveAll(cowLayerDir)
			}
			egressSess.Close()
		}
	}
	return launch, nil
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

// branchTotal is the per-branch denominator sidecar: the case count of the last
// run against a branch, plus the commit it was computed for (informational).
type branchTotal struct {
	Total     int    `json:"total"`
	Ref       string `json:"ref,omitempty"`
	UpdatedAt int64  `json:"updated_at"`
}

func readBranchTotal(dir string) (branchTotal, bool) {
	data, err := os.ReadFile(filepath.Join(dir, branchTotalFile))
	if err != nil {
		return branchTotal{}, false
	}
	var bt branchTotal
	if err := json.Unmarshal(data, &bt); err != nil {
		return branchTotal{}, false
	}
	return bt, true
}

func writeBranchTotal(dir string, bt branchTotal) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	data, err := json.MarshalIndent(bt, "", "  ")
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(filepath.Join(dir, branchTotalFile), data, 0o644))
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
