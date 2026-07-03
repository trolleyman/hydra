package http

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"time"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	hydratests "github.com/trolleyman/hydra/internal/tests"
)

// autoMergeFinishedDwell is how long a head must have sat in the finished state
// before merge-when-green fires. Auto-merge waits for the agent to actually be
// done — not merely for the branch tip to be green — so it never merges a head
// mid-work (e.g. one that committed a passing intermediate state and kept going)
// or on a momentary finished blip between turns.
const autoMergeFinishedDwell = 10 * time.Second

// headFinishedFor reports whether a's agent has held the finished state, with its
// session still alive, for at least dwell. running/needs_input/waiting and a
// stopped or dead session all return false: auto-merge only fires for a head that
// genuinely completed its turn and has stayed settled — never a still-working
// head, one blocked asking the user, or one whose session ended.
func headFinishedFor(a db.Agent, dwell time.Duration, now time.Time) bool {
	if a.SessionStatus != "running" || a.AgentStatus == nil || *a.AgentStatus != "finished" {
		return false
	}
	t, err := time.Parse(time.RFC3339Nano, a.AgentStatusTime)
	if err != nil {
		return false // no reliable timestamp — wait rather than merge early
	}
	return now.Sub(t) >= dwell
}

// testRunnersFor resolves the enabled [[tests]] runners that apply to one version
// of the project, read from that version's own .hydra/config.toml — the worktree's
// file for an uncommitted working tree, else the committed file at the ref — so a
// branch's own [[tests]] edits (a changed command/timeout, or an added/removed
// runner) take effect on that branch without merging, mirroring [[artifacts]].
// Runners with an empty name/command, disabled (enabled = false), or a duplicate
// name (first wins) are dropped.
//
// Security: a version's config is attacker-controllable, so unsafe_host is honored
// only when the trusted live/root config (config.Load of the project root, what a
// human controls on the base branch) authorizes that exact name+command — else the
// command is forced back into the sandbox — and a runner the live config disables
// by name is dropped regardless of what the branch says. Sandboxed commands need no
// gate: the sandbox is the boundary and already runs the checkout's untrusted code.
func (s *Server) testRunnersFor(projectRoot string, v hydratests.Version, liveCfg config.Config) []config.TestScript {
	var content []byte
	if v.WorktreeDir != "" {
		data, err := os.ReadFile(config.GetProjectConfigPath(v.WorktreeDir))
		if err != nil && !os.IsNotExist(err) {
			return nil
		}
		content = data // nil when absent → inherits the user config's tests
	} else {
		data, err := git.ShowFile(projectRoot, v.Ref, ".hydra/config.toml")
		if err != nil {
			return nil
		}
		content = data
	}

	specs, err := config.TestsAtProjectTOML(content)
	if err != nil {
		return nil
	}
	trustedHost := trustedHostTestCommands(liveCfg)
	disabled := disabledTests(liveCfg)
	seen := make(map[string]bool, len(specs))
	out := make([]config.TestScript, 0, len(specs))
	for _, t := range specs {
		if t.Name == "" || t.Command == "" || !t.IsEnabled() {
			continue
		}
		if seen[t.Name] || disabled[t.Name] {
			continue
		}
		seen[t.Name] = true
		if t.UnsafeHost && !trustedHost[hostKey(t.Name, t.Command)] {
			// A branch can't grant itself host access; force it into the sandbox.
			t.UnsafeHost = false
		}
		out = append(out, t)
	}
	return out
}

// disabledTests returns the runner names the live config marks enabled = false — a
// human kill-switch a branch's own config can't override. Mirrors disabledArtifacts.
func disabledTests(cfg config.Config) map[string]bool {
	disabled := map[string]bool{}
	for _, t := range cfg.Tests {
		if t.Name != "" && !t.IsEnabled() {
			disabled[t.Name] = true
		}
	}
	return disabled
}

// trustedHostTestCommands returns the name+command pairs the live config authorizes
// to run unconfined on the host (unsafe_host = true). Mirrors trustedHostCommands.
func trustedHostTestCommands(cfg config.Config) map[string]bool {
	trusted := map[string]bool{}
	for _, t := range cfg.Tests {
		if t.UnsafeHost && t.Name != "" && t.Command != "" {
			trusted[hostKey(t.Name, t.Command)] = true
		}
	}
	return trusted
}

// testVersion resolves which checkout a head's tests run against: its uncommitted
// working tree (when requested and available), an explicit ref, or its branch tip.
func testVersion(head *heads.Head, headRef *string, includeUncommitted bool) hydratests.Version {
	switch {
	case includeUncommitted && head.Worktree != nil:
		return hydratests.Version{WorktreeDir: *head.Worktree}
	case headRef != nil && *headRef != "":
		return hydratests.Version{Ref: *headRef}
	case head.Branch != nil:
		return hydratests.Version{Ref: *head.Branch}
	default:
		return hydratests.Version{}
	}
}

// GetAgentTests runs (or returns cached) the head's test runners for one ref and
// reports each runner's parsed verdict (single-sided; no before/after diff).
func (s *Server) GetAgentTests(ctx context.Context, request api.GetAgentTestsRequestObject) (api.GetAgentTestsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.GetAgentTests404JSONResponse{Code: 404, Error: api.ErrorResponseErrorNotFound, Details: "agent not found"}, nil
	}
	if s.Tests == nil || head.Branch == nil {
		return api.GetAgentTests200JSONResponse(api.TestsResponse{Runners: []api.TestRunResult{}}), nil
	}

	mgr := s.Tests.Manager(projectRoot)
	includeUncommitted := request.Params.IncludeUncommitted != nil && *request.Params.IncludeUncommitted
	v := testVersion(head, request.Params.HeadRef, includeUncommitted)

	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	runners := s.testRunnersFor(projectRoot, v, liveCfg)
	if len(runners) == 0 {
		return api.GetAgentTests200JSONResponse(api.TestsResponse{Runners: []api.TestRunResult{}}), nil
	}

	// A refresh names one runner whose cached result (incl. a cached failure) the
	// user wants discarded and re-run before responding.
	if request.Params.Refresh != nil && *request.Params.Refresh != "" {
		_ = mgr.Invalidate(*request.Params.Refresh, v)
	}

	out := s.buildTestRunners(request.ProjectId, mgr, runners, v)
	return api.GetAgentTests200JSONResponse(api.TestsResponse{Runners: out}), nil
}

// buildTestRunResult maps a tests.Report into the API shape, including a live log
// while running and a log_url once settled.
func buildTestRunResult(projectID string, mgr *hydratests.Manager, rep hydratests.Report) api.TestRunResult {
	res := api.TestRunResult{
		Name:       rep.Runner,
		Status:     api.TestStatus(rep.Status),
		Total:      ptr(rep.Total),
		Passed:     ptr(rep.Passed),
		Failed:     ptr(rep.Failed),
		Skipped:    ptr(rep.Skipped),
		Warnings:   ptr(rep.Warnings),
		DurationMs: ptr(rep.DurationMs),
		Error:      nonEmptyPtr(rep.Error),
		Ref:        nonEmptyPtr(rep.Ref),
		Format:     nonEmptyPtr(rep.Format),
	}
	if len(rep.Cases) > 0 {
		res.Cases = ptr(toAPITestCases(rep.Cases))
	}
	if rep.Status == hydratests.StatusRunning {
		if rep.StartedAt > 0 {
			res.StartedAt = ptr(rep.StartedAt)
		}
		res.Progress = nonEmptyPtr(rep.Progress)
		if len(rep.Log) > 0 {
			res.Log = ptr(toAPITestLog(rep.Log))
		}
	} else if rep.Key != "" && mgr.HasLog(rep.Runner, rep.Key) {
		res.LogUrl = ptr(testLogURL(projectID, rep.Runner, rep.Key))
	}
	return res
}

// toAPITestCases maps parsed cases into the API shape, shared by the full
// report (buildTestRunResult) and the streamed "counts" WS increments.
func toAPITestCases(cases []hydratests.TestCase) []api.TestCase {
	out := make([]api.TestCase, 0, len(cases))
	for _, c := range cases {
		ac := api.TestCase{
			Name:       c.Name,
			Status:     api.TestCaseStatus(c.Status),
			Path:       nonEmptyPtr(c.Path),
			DurationMs: ptr(c.DurationMs),
			Message:    nonEmptyPtr(c.Message),
		}
		if len(c.Scope) > 0 {
			scope := append([]string(nil), c.Scope...)
			ac.Scope = &scope
		}
		if len(c.ScopeKinds) > 0 {
			kinds := append([]string(nil), c.ScopeKinds...)
			ac.ScopeKinds = &kinds
		}
		if c.Line > 0 {
			ac.Line = ptr(c.Line)
		}
		if c.Col > 0 {
			ac.Col = ptr(c.Col)
		}
		if c.EndLine > 0 {
			ac.EndLine = ptr(c.EndLine)
		}
		if c.EndCol > 0 {
			ac.EndCol = ptr(c.EndCol)
		}
		if c.PathMissing {
			ac.PathMissing = ptr(true)
		}
		out = append(out, ac)
	}
	return out
}

func toAPITestLog(lines []hydratests.LogLine) []api.ArtifactLogLine {
	out := make([]api.ArtifactLogLine, 0, len(lines))
	for _, l := range lines {
		out = append(out, api.ArtifactLogLine{Text: l.Text, Stream: api.ArtifactLogLineStream(l.Stream)})
	}
	return out
}

func testLogURL(projectID, runner, key string) string {
	q := url.Values{}
	q.Set("runner", runner)
	q.Set("key", key)
	return fmt.Sprintf("/tests/projects/%s/log?%s", url.PathEscape(projectID), q.Encode())
}

// HandleTestLog serves the persisted build log for one settled test run, mirroring
// HandleArtifactLog. Addressed by the opaque (runner, key) URL the result hands out.
func (s *Server) HandleTestLog(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project_id")
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil || s.Tests == nil {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	lines, ok := s.Tests.Manager(projectRoot).ReadLog(q.Get("runner"), q.Get("key"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	api.WriteJSON(w, http.StatusOK, struct {
		Lines []api.ArtifactLogLine `json:"lines"`
	}{Lines: toAPITestLog(lines)})
}

// testSummaryFor computes the compact per-head verdict chip for the head's branch
// tip, reading the cache without triggering a run (cheap enough for the agent list
// when tests are configured). Returns nil when the feature is off or the head has
// no branch; a "none" status when no runners are configured / never run.
func (s *Server) testSummaryFor(projectRoot string, h heads.Head) *api.TestSummary {
	if s.Tests == nil || h.Branch == nil || h.Archived {
		return nil
	}
	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return &api.TestSummary{Status: api.TestStatusNone}
	}
	runners := s.testRunnersFor(projectRoot, hydratests.Version{Ref: *h.Branch}, liveCfg)
	if len(runners) == 0 {
		return &api.TestSummary{Status: api.TestStatusNone}
	}
	// Detect whether the head has done no work of its own yet: if its branch tip
	// is a reachable ancestor of the base branch — i.e. the head can fast-forward
	// to base, with no commits the base doesn't already have — then any cached
	// verdict belongs to the base, not the agent. (Plain tip == base is the
	// special case; this also covers the base moving on ahead of an idle head, so
	// committing to base no longer un-hides the chip.) We still surface the real
	// verdict — the agent detail view (header chip + Tests panel) shows it — but
	// flag it so the ambient sidebar chip can hide it, where a green "passed"
	// inherited from base would just be misleading noise. Best-effort: if either
	// ref fails to resolve, or the ancestry check errors, we leave the flag unset
	// and fall through to the normal computation.
	atBase := false
	if h.BaseBranch != "" {
		headSHA, errHead := git.ResolveRef(projectRoot, *h.Branch)
		baseSHA, errBase := git.ResolveRef(projectRoot, h.BaseBranch)
		if errHead == nil && errBase == nil {
			if ff, err := git.IsAncestor(projectRoot, headSHA, baseSHA); err == nil && ff {
				atBase = true
			}
		}
	}
	mgr := s.Tests.Manager(projectRoot)
	v := hydratests.Version{Ref: *h.Branch}

	var anyRunning, anyFailing, anyErrored, anyStale bool
	var total, passed, failed, skipped, warnings int
	var dur int64
	var progress, ref string
	cached, missing := 0, 0
	for _, r := range runners {
		rep, ok, err := mgr.Peek(r.Name, v)
		if err != nil {
			missing++
			continue
		}
		if !ok {
			// No verdict for the current commit — a cached older one means stale.
			if old, found := mgr.Latest(r.Name); found {
				anyStale = true
				total += old.Total
				passed += old.Passed
				failed += old.Failed
				skipped += old.Skipped
				warnings += old.Warnings
			} else {
				missing++
			}
			continue
		}
		cached++
		ref = rep.Ref
		total += rep.Total
		passed += rep.Passed
		failed += rep.Failed
		skipped += rep.Skipped
		warnings += rep.Warnings
		dur += rep.DurationMs
		switch rep.Status {
		case hydratests.StatusRunning:
			anyRunning = true
			if rep.Progress != "" {
				progress = rep.Progress
			}
		case hydratests.StatusFailing:
			anyFailing = true
		case hydratests.StatusErrored:
			anyErrored = true
		}
	}

	status := api.TestStatusNone
	switch {
	case anyRunning:
		status = api.TestStatusRunning
	case anyFailing:
		status = api.TestStatusFailing
	case anyErrored:
		status = api.TestStatusErrored
	case anyStale:
		status = api.TestStatusStale
	case cached == len(runners):
		status = api.TestStatusPassing
	default:
		// Some runners never ran and nothing stronger to show.
		status = api.TestStatusNone
	}

	sum := &api.TestSummary{Status: status, Total: &total, Passed: &passed, Failed: &failed, Skipped: &skipped, Warnings: &warnings}
	if dur > 0 {
		sum.DurationMs = &dur
	}
	if progress != "" {
		sum.Progress = &progress
	}
	if ref != "" {
		sum.Ref = &ref
	}
	if atBase {
		sum.AtBase = &atBase
	}
	return sum
}

// NotifyTestsProgress recomputes the live test summary of every head whose
// tests are currently running and pushes each over the events WS as an
// agent_tests_changed payload event, so sidebar/header chips tick in place
// without every client refetching the whole agent list. Invoked (throttled per
// run, see tests.Manager.onProgress) while a streamed type=stdout run appends
// cases; the settle path still fires a full agents_changed refresh.
func (s *Server) NotifyTestsProgress(projectRoot string) {
	if s.Events == nil || s.Tests == nil || s.DB == nil {
		return
	}
	headList, err := heads.ListHeads(context.Background(), s.Sessions, s.DB, projectRoot)
	if err != nil {
		return // best-effort: the agent-list poll still catches up
	}
	for _, h := range headList {
		sum := s.testSummaryFor(projectRoot, h)
		if sum == nil || sum.Status != api.TestStatusRunning {
			continue
		}
		s.Events.AgentTestsChanged(projectRoot, h.ID, agentTestsPayload{AgentID: h.ID, Tests: sum})
	}
}

// RunAutoMergeWatcher polls for heads with auto-merge armed (PLAN #68) and acts
// when their tests settle: merges a head whose tests are all passing, and
// disarms (with an agents-changed nudge so the UI can toast) one whose tests
// went failing/errored. A head still running is left armed. It runs until ctx is
// cancelled. A poll is cheap when nothing is armed (the common case), and the
// single daemon serves every project, so it scans armed heads across all of them.
func (s *Server) RunAutoMergeWatcher(ctx context.Context) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.checkArmedMerges(ctx)
		}
	}
}

func (s *Server) checkArmedMerges(ctx context.Context) {
	if s.DB == nil || s.Tests == nil {
		return
	}
	armed, err := s.DB.ArmedMergeWhenGreen()
	if err != nil || len(armed) == 0 {
		return
	}
	for _, a := range armed {
		projectRoot := a.ProjectPath
		head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, a.ID)
		if err != nil || head == nil || head.Branch == nil {
			continue
		}
		v := hydratests.Version{Ref: *head.Branch}
		liveCfg, err := config.Load(projectRoot)
		if err != nil {
			continue // transient config read error — retry next tick
		}
		runners := s.testRunnersFor(projectRoot, v, liveCfg)
		if len(runners) == 0 {
			// Nothing to gate on — disarm so it doesn't linger forever.
			_ = s.DB.SetMergeWhenGreen(a.ID, false, "")
			s.notifyAgentsChanged(projectRoot, true)
			continue
		}
		mgr := s.Tests.Manager(projectRoot)

		anyBad, anyRunning, missing := false, false, false
		passing := 0
		for _, r := range runners {
			rep, ok, perr := mgr.Peek(r.Name, v)
			if perr != nil || !ok {
				missing = true
				continue
			}
			switch rep.Status {
			case hydratests.StatusPassing:
				passing++
			case hydratests.StatusFailing, hydratests.StatusErrored:
				anyBad = true
			case hydratests.StatusRunning:
				anyRunning = true
			}
		}

		switch {
		case anyBad:
			// Tests went red — never auto-merge a failing commit. Disarm + nudge.
			_ = s.DB.SetMergeWhenGreen(a.ID, false, "")
			s.notifyAgentsChanged(projectRoot, true)
		case anyRunning:
			// Still in flight — keep waiting.
		case missing:
			// No verdict yet for the current commit (e.g. a new commit landed) —
			// kick a run so a verdict materialises for the next poll.
			for _, r := range runners {
				_, _ = mgr.Get(r, v)
			}
		case passing == len(runners):
			// Tests are green — but only merge once the agent has actually settled
			// into finished (not merely a green intermediate commit while it keeps
			// working). Waiting keeps the head armed; the next tick re-checks.
			if !headFinishedFor(a, autoMergeFinishedDwell, time.Now()) {
				continue
			}
			s.autoMerge(ctx, projectRoot, *head)
		}
	}
}

// autoMerge claims and merges a head whose tests are all passing, consuming the
// merge-when-green intent. A failed claim (a concurrent operation) just leaves it
// armed for the next poll; a merge conflict disarms it and surfaces via LastError.
func (s *Server) autoMerge(ctx context.Context, projectRoot string, head heads.Head) {
	if s.DB != nil {
		ok, err := s.DB.TrySetHeadStatus(head.ID, "idle", "merging")
		if err != nil || !ok {
			return // busy; retry next tick
		}
	}
	// Consume the intent up front so a merge that fails (conflict) doesn't loop.
	_ = s.DB.SetMergeWhenGreen(head.ID, false, "")
	conflict, err := s.performClaimedMerge(ctx, projectRoot, head, true)
	if err != nil || conflict != nil {
		s.notifyAgentsChanged(projectRoot, true)
	}
}

// testGateVerdict decides whether the test gate should block a merge of head. It
// reads the head's branch-tip verdict (running a missing one foreground so the
// gate has something to judge): blocked is true when any enabled runner is
// failing, errored, or still running. code is tests_failing when a runner is
// genuinely red (with the failing-case count), else tests_errored (couldn't run
// / still running — "no verdict, not a pass"). Returns blocked=false when the
// feature is off, no runners are configured, or every runner is passing.
func (s *Server) testGateVerdict(projectRoot string, h heads.Head) (code api.MergeConflictErrorError, failing int, blocked bool) {
	if s.Tests == nil || h.Branch == nil {
		return "", 0, false
	}
	v := hydratests.Version{Ref: *h.Branch}
	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		// Can't resolve the trusted config — treat as "no verdict", which blocks
		// (errored) rather than waving the merge through.
		return api.MergeConflictErrorErrorTestsErrored, 0, true
	}
	runners := s.testRunnersFor(projectRoot, v, liveCfg)
	if len(runners) == 0 {
		return "", 0, false
	}
	mgr := s.Tests.Manager(projectRoot)

	anyFailing, anyErrored, anyRunning := false, 0, false
	for _, r := range runners {
		// Get (not Peek) so a never-run gate computes a verdict instead of waving
		// the merge through; it returns running immediately if it kicks a run.
		rep, err := mgr.Get(r, v)
		if err != nil {
			anyErrored++
			continue
		}
		switch rep.Status {
		case hydratests.StatusFailing:
			anyFailing = true
			failing += rep.Failed
		case hydratests.StatusErrored:
			anyErrored++
		case hydratests.StatusRunning:
			anyRunning = true
		}
	}
	switch {
	case anyFailing:
		return api.MergeConflictErrorErrorTestsFailing, failing, true
	case anyErrored > 0 || anyRunning:
		// Errored ("we don't know") and running ("not yet") both block as
		// tests_errored — distinct from a confirmed red.
		return api.MergeConflictErrorErrorTestsErrored, 0, true
	default:
		return "", 0, false
	}
}

// ArmMergeWhenGreen arms auto-merge for a head and kicks a test run if none is
// fresh, so the verdict settles and the watcher can act.
func (s *Server) ArmMergeWhenGreen(ctx context.Context, request api.ArmMergeWhenGreenRequestObject) (api.ArmMergeWhenGreenResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil || head.Branch == nil {
		return api.ArmMergeWhenGreen404JSONResponse{Code: 404, Error: api.ErrorResponseErrorNotFound, Details: "agent not found"}, nil
	}
	if s.DB != nil {
		if err := s.DB.SetMergeWhenGreen(head.ID, true, time.Now().UTC().Format(time.RFC3339)); err != nil {
			return nil, errtrace.Wrap(err)
		}
	}
	// Kick a run so a verdict exists for the watcher to act on.
	if s.Tests != nil {
		mgr := s.Tests.Manager(projectRoot)
		v := hydratests.Version{Ref: *head.Branch}
		if liveCfg, err := config.Load(projectRoot); err == nil {
			for _, r := range s.testRunnersFor(projectRoot, v, liveCfg) {
				_, _ = mgr.Get(r, v)
			}
		}
	}
	s.notifyAgentsChanged(projectRoot, true)
	return api.ArmMergeWhenGreen204Response{}, nil
}

// DisarmMergeWhenGreen clears the auto-merge intent for a head.
func (s *Server) DisarmMergeWhenGreen(ctx context.Context, request api.DisarmMergeWhenGreenRequestObject) (api.DisarmMergeWhenGreenResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if s.DB != nil {
		if err := s.DB.SetMergeWhenGreen(request.Id, false, ""); err != nil {
			return nil, errtrace.Wrap(err)
		}
	}
	s.notifyAgentsChanged(projectRoot, true)
	return api.DisarmMergeWhenGreen204Response{}, nil
}
