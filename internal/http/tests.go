package http

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
	hydratests "github.com/trolleyman/hydra/internal/tests"
)

// enabledTestRunners returns the project's live [[tests]] runners that are
// enabled. The live config is authoritative (trusted-by-where-it's-read), never
// a diffed ref's own config — see PLAN #26's red flag.
func enabledTestRunners(projectRoot string) []config.TestScript {
	cfg, err := config.Load(projectRoot)
	if err != nil {
		return nil
	}
	var out []config.TestScript
	for _, t := range cfg.Tests {
		if t.IsEnabled() {
			out = append(out, t)
		}
	}
	return out
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
	runners := enabledTestRunners(projectRoot)
	if s.Tests == nil || head.Branch == nil || len(runners) == 0 {
		return api.GetAgentTests200JSONResponse(api.TestsResponse{Runners: []api.TestRunResult{}}), nil
	}

	mgr := s.Tests.Manager(projectRoot)
	includeUncommitted := request.Params.IncludeUncommitted != nil && *request.Params.IncludeUncommitted
	v := testVersion(head, request.Params.HeadRef, includeUncommitted)

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
		DurationMs: ptr(rep.DurationMs),
		Error:      nonEmptyPtr(rep.Error),
		Ref:        nonEmptyPtr(rep.Ref),
		Format:     nonEmptyPtr(rep.Format),
	}
	if len(rep.Cases) > 0 {
		cases := make([]api.TestCase, 0, len(rep.Cases))
		for _, c := range rep.Cases {
			cases = append(cases, api.TestCase{
				Name:       c.Name,
				Status:     api.TestCaseStatus(c.Status),
				DurationMs: ptr(c.DurationMs),
				Message:    nonEmptyPtr(c.Message),
			})
		}
		res.Cases = &cases
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
	runners := enabledTestRunners(projectRoot)
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
	var total, passed, failed, skipped int
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

	sum := &api.TestSummary{Status: status, Total: &total, Passed: &passed, Failed: &failed, Skipped: &skipped}
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
		runners := enabledTestRunners(projectRoot)
		if len(runners) == 0 {
			// Nothing to gate on — disarm so it doesn't linger forever.
			_ = s.DB.SetMergeWhenGreen(a.ID, false, "")
			s.notifyAgentsChanged(projectRoot, true)
			continue
		}
		mgr := s.Tests.Manager(projectRoot)
		v := hydratests.Version{Ref: *head.Branch}

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
	conflict, err := s.performClaimedMerge(ctx, projectRoot, head)
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
	runners := enabledTestRunners(projectRoot)
	if len(runners) == 0 {
		return "", 0, false
	}
	mgr := s.Tests.Manager(projectRoot)
	v := hydratests.Version{Ref: *h.Branch}

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
		for _, r := range enabledTestRunners(projectRoot) {
			_, _ = mgr.Get(r, v)
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
