package http

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/reviewq"
	hydratests "github.com/trolleyman/hydra/internal/tests"
)

const (
	// headStatusMaxCases caps how many failing/errored test cases a status answer
	// names. A 4,000-case suite can fail in bulk, and the point of the list is to
	// tell the agent WHAT broke, not to paste the whole run into its context - the
	// tail is summarised as a count instead.
	headStatusMaxCases = 15
	// headStatusMessageLen truncates a one-line detail (a progress line, a service's
	// message, an errored runner's error).
	headStatusMessageLen = 300
	// A failing case's message is the single most useful thing in the whole answer -
	// it is usually the assertion that says what to fix - so it is kept as MULTIPLE
	// lines (an expected/actual diff is unreadable flattened), bounded three ways:
	// per-message lines, per-message characters, and a budget across the whole
	// answer so a suite failing in bulk still can't run away with the context.
	caseMessageLines  = 8
	caseMessageLen    = 600
	caseMessageBudget = 4000
	// runCooldown bounds how often an agent may re-run the same runner/script at the
	// same commit. A run already in flight is a no-op anyway (both managers reuse
	// it), so this only guards the tight loop of "finished -> immediately re-run",
	// which would spend the user's CPU to no purpose. Short enough that a genuine
	// retry of a flaky test just waits a moment.
	runCooldown = 30 * time.Second
	// headStatusLogTail is how much of a runner's log get_head_status inlines when
	// it has no case-level detail to show (a build that died before producing a
	// report, an `exit`-format runner that parses no cases). Without this the
	// answer for those is just "FAILING", which tells the agent nothing and costs it
	// a second round trip to learn anything at all.
	headStatusLogTail = 25
	// testLogsDefaultTail / testLogsMaxTail bound get_test_logs. The default is
	// what a failing build's tail usually needs; the cap stops a `tail` argument
	// from turning a 200k-line CI log into one tool result. The failure is
	// virtually always at the END of the log, so both take the tail, not the head.
	testLogsDefaultTail = 200
	testLogsMaxTail     = 2000
)

// headStatusText renders a head's own tests, artifacts and services for the
// get_head_status MCP tool. It is strictly read-only: every lookup goes through a
// Peek, so an agent asking how it is doing never starts a test run or an artifact
// generation (which would then report itself as "running" - a status call that
// causes the thing it reports is a trap).
//
// The status is measured against the head's branch TIP, which is the same version
// the merge and publish gates use, so "passing" here means the same thing as the
// green gate. Uncommitted work is deliberately not included: the agent can run
// its own command for that, and a verdict that disagrees with the gate would be
// worse than no verdict.
func (s *Server) headStatusText(ctx context.Context, id string) reviewq.Result {
	head, projectRoot, err := s.headForStatus(ctx, id)
	if err != "" {
		return reviewq.Result{Message: err}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Head %s on branch %s (base %s).\n", head.ID, deref(head.Branch), head.BaseBranch)
	b.WriteString("All verdicts below are for the branch's latest COMMIT - uncommitted work in your worktree is not included.\n")

	b.WriteString("\n## Tests\n")
	b.WriteString(s.headTestsText(projectRoot, head))
	b.WriteString("\n## Artifacts\n")
	b.WriteString(s.headArtifactsText(projectRoot, head))
	b.WriteString("\n## Services\n")
	b.WriteString(s.headServicesText(projectRoot))

	return reviewq.Result{OK: true, Message: b.String()}
}

// headTestsText renders every configured runner's cached verdict for the head's
// branch tip, plus the failing case names. A runner with no cached verdict is
// reported as such rather than run - see headStatusText.
func (s *Server) headTestsText(projectRoot string, head *heads.Head) string {
	if s.Tests == nil || head.Branch == nil {
		return "Tests are not available for this head.\n"
	}
	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return "The project config could not be read, so the test runners are unknown.\n"
	}
	v := hydratests.Version{Ref: *head.Branch}
	runners := s.testRunnersFor(projectRoot, v, liveCfg)
	if len(runners) == 0 {
		return "This project configures no test runners, so there is no test gate to pass.\n"
	}
	mgr := s.Tests.Manager(projectRoot)

	var b strings.Builder
	for _, r := range runners {
		rep, ok, perr := mgr.Peek(r.Name, v)
		switch {
		case perr != nil:
			fmt.Fprintf(&b, "- %s: unknown (%v)\n", r.Name, perr)
			continue
		case !ok:
			fmt.Fprintf(&b, "- %s: NOT RUN yet for this commit. Hydra runs it on its own; ask the user to run it from the tests panel if you need a verdict now.\n", r.Name)
			continue
		case rep.Status == hydratests.StatusRunning:
			fmt.Fprintf(&b, "- %s: RUNNING%s\n", r.Name, progressSuffix(rep.Progress))
			continue
		case rep.Status == hydratests.StatusErrored:
			fmt.Fprintf(&b, "- %s: ERRORED (the runner itself failed, so there is no verdict): %s\n", r.Name, oneLine(rep.Error, headStatusMessageLen))
			b.WriteString(logTailText(mgr, r.Name, rep.Key))
			fmt.Fprintf(&b, "  Call get_test_logs with runner %q for its full output.\n", r.Name)
			continue
		}
		fmt.Fprintf(&b, "- %s: %s (%d passed, %d failed, %d skipped of %d)\n",
			r.Name, strings.ToUpper(string(rep.Status)), rep.Passed, rep.Failed, rep.Skipped, rep.Total)
		if rep.Status != hydratests.StatusFailing {
			continue
		}
		// The failure messages are the answer to "what do I fix?", so they are
		// inlined here rather than left behind a second tool call. Only when there
		// are none - no parsed cases, or cases carrying no message - does the log
		// tail stand in for them.
		cases, cerr := mgr.PeekCases(r.Name, v)
		detail, withMessages := "", 0
		if cerr == nil {
			detail, withMessages = failingCasesText(cases)
			b.WriteString(detail)
		}
		if withMessages == 0 {
			b.WriteString(logTailText(mgr, r.Name, rep.Key))
		}
		fmt.Fprintf(&b, "  Call get_test_logs with runner %q for the full output.\n", r.Name)
	}
	if b.Len() == 0 {
		return "No test verdicts are available.\n"
	}
	return b.String()
}

// failingCasesText lists the failed cases of a report with their failure
// messages, capped at headStatusMaxCases with the remainder counted. It also
// returns how many cases contributed an actual message, so the caller can fall
// back to the log tail when the list turns out to be names with nothing behind
// them (which is no more use to an agent than "FAILING" alone).
func failingCasesText(cases []hydratests.TestCase) (string, int) {
	var failing []hydratests.TestCase
	for _, c := range cases {
		if c.Status == hydratests.CaseFailed {
			failing = append(failing, c)
		}
	}
	if len(failing) == 0 {
		return "", 0
	}
	var b strings.Builder
	shown := failing
	if len(shown) > headStatusMaxCases {
		shown = shown[:headStatusMaxCases]
	}
	budget, withMessages := caseMessageBudget, 0
	for _, c := range shown {
		name := c.Name
		if len(c.Scope) > 0 {
			name = strings.Join(c.Scope, " > ") + " > " + name
		}
		where := ""
		if c.Path != "" {
			where = " [" + c.Path
			if c.Line > 0 {
				where += fmt.Sprintf(":%d", c.Line)
			}
			where += "]"
		}
		fmt.Fprintf(&b, "  - %s%s\n", name, where)
		msg := clampMessage(c.Message, caseMessageLines, min(caseMessageLen, budget))
		if msg == "" {
			continue
		}
		withMessages++
		budget -= len(msg)
		// Indented under its case so a multi-line assertion stays visibly attached
		// to the test it belongs to.
		for line := range strings.SplitSeq(msg, "\n") {
			fmt.Fprintf(&b, "      %s\n", line)
		}
	}
	if rest := len(failing) - len(shown); rest > 0 {
		fmt.Fprintf(&b, "  ... and %d more failing case(s) - call get_test_logs for the rest.\n", rest)
	}
	if budget <= 0 {
		b.WriteString("  (later failure messages were dropped to keep this short - call get_test_logs for them)\n")
	}
	return b.String(), withMessages
}

// clampMessage trims a failure message to at most maxLines lines and maxChars
// characters, keeping its shape (an expected/actual diff is unreadable flattened
// onto one line, which is why this is not oneLine).
func clampMessage(text string, maxLines, maxChars int) string {
	t := strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
	if t == "" || maxChars <= 0 {
		return ""
	}
	lines := strings.Split(t, "\n")
	truncated := false
	if len(lines) > maxLines {
		lines, truncated = lines[:maxLines], true
	}
	t = strings.TrimRight(strings.Join(lines, "\n"), "\n")
	if len(t) > maxChars {
		t, truncated = t[:maxChars], true
	}
	if truncated {
		t += "\n      ... (truncated - call get_test_logs for the rest)"
	}
	return t
}

// logTailText renders the last headStatusLogTail lines of a settled runner's
// persisted log, for a failure with no case-level detail to show. Empty when
// there is no log (an in-flight run's output is not persisted yet).
func logTailText(mgr *hydratests.Manager, runner, key string) string {
	lines, ok := mgr.ReadLog(runner, key)
	if !ok || len(lines) == 0 {
		return ""
	}
	var b strings.Builder
	shown := lines
	if len(shown) > headStatusLogTail {
		shown = shown[len(shown)-headStatusLogTail:]
		fmt.Fprintf(&b, "  No per-test detail; last %d of %d output lines:\n", len(shown), len(lines))
	} else {
		fmt.Fprintf(&b, "  No per-test detail; its %d output lines:\n", len(lines))
	}
	for _, l := range shown {
		fmt.Fprintf(&b, "      %s\n", l.Text)
	}
	return b.String()
}

// headArtifactsText renders the head's artifact sets at its branch tip. Server
// ("preview") specs are dropped: they have no diffable output, they are a
// user-facing live-server affordance, and a head cannot reach the preview port
// under hard egress anyway.
func (s *Server) headArtifactsText(projectRoot string, head *heads.Head) string {
	if s.Artifacts == nil || head.Branch == nil {
		return "Artifacts are not available for this head.\n"
	}
	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return "The project config could not be read, so the artifact scripts are unknown.\n"
	}
	v := artifacts.Version{Ref: *head.Branch}
	specs, err := artifactSpecsByName(projectRoot, v, liveCfg)
	if err != nil {
		return "The artifact scripts could not be resolved: " + err.Error() + "\n"
	}
	for name := range disabledArtifacts(liveCfg) {
		delete(specs, name)
	}
	if len(specs) == 0 {
		return "This project configures no artifacts.\n"
	}
	mgr := s.Artifacts.Manager(projectRoot)

	names := make([]string, 0, len(specs))
	for name := range specs {
		names = append(names, name)
	}
	sort.Strings(names)

	var b strings.Builder
	for _, name := range names {
		meta, ok, perr := mgr.Peek(name, v)
		switch {
		case perr != nil:
			fmt.Fprintf(&b, "- %s: unknown (%v)\n", name, perr)
		case !ok:
			fmt.Fprintf(&b, "- %s: NOT GENERATED yet for this commit.\n", name)
		case meta.Status == artifacts.StatusGenerating:
			fmt.Fprintf(&b, "- %s: GENERATING%s\n", name, progressSuffix(meta.Progress))
		case meta.Status == artifacts.StatusError:
			fmt.Fprintf(&b, "- %s: FAILED: %s\n", name, oneLine(meta.Error, headStatusMessageLen))
		default:
			fmt.Fprintf(&b, "- %s: ready, %d file(s)%s\n", name, len(meta.Files), artifactFileNames(meta))
		}
	}
	return b.String()
}

// artifactFileNames lists a ready set's file names, capped so a 200-screenshot
// set doesn't dominate the answer.
func artifactFileNames(meta artifacts.Meta) string {
	if len(meta.Files) == 0 {
		return ""
	}
	const max = 10
	names := make([]string, 0, len(meta.Files))
	for _, f := range meta.Files {
		if len(names) == max {
			names = append(names, fmt.Sprintf("... +%d more", len(meta.Files)-max))
			break
		}
		names = append(names, f.Name)
	}
	return ": " + strings.Join(names, ", ")
}

// headServicesText renders the project's supervised [[services]]. They are
// per-project, not per-head (one pool shared by every head of the project), so
// this is the one section that describes something the head shares with its
// siblings - worth saying, since a service another head's work broke looks
// identical from here to one this head broke.
func (s *Server) headServicesText(projectRoot string) string {
	if s.Services == nil {
		return "Services are not available.\n"
	}
	sts := s.Services.Status(projectRoot)
	if len(sts) == 0 {
		return "This project configures no services.\n"
	}
	var b strings.Builder
	b.WriteString("These are the PROJECT's services, shared by every head - not yours alone.\n")
	for _, st := range sts {
		fmt.Fprintf(&b, "- %s: %s", st.Name, strings.ToUpper(string(st.State)))
		if st.Restarts > 0 {
			fmt.Fprintf(&b, " (%d restart(s) of %d)", st.Restarts, st.MaxRestarts)
		}
		if msg := oneLine(st.Message, headStatusMessageLen); msg != "" {
			fmt.Fprintf(&b, ": %s", msg)
		}
		b.WriteString("\n")
	}
	return b.String()
}

// testLogsText renders the tail of one runner's captured output for the head's
// branch tip. Read-only, like headStatusText: a runner that has not run has no
// log, and this will not start one.
func (s *Server) testLogsText(ctx context.Context, id string, req reviewq.Request) reviewq.Result {
	head, projectRoot, errMsg := s.headForStatus(ctx, id)
	if errMsg != "" {
		return reviewq.Result{Message: errMsg}
	}
	runner := strings.TrimSpace(req.Runner)
	if runner == "" {
		return reviewq.Result{Message: "No runner was named. Call get_head_status first to see this project's runners, then pass one as \"runner\"."}
	}
	if s.Tests == nil || head.Branch == nil {
		return reviewq.Result{Message: "Tests are not available for this head, so it has no logs."}
	}
	tail := req.Tail
	if tail <= 0 {
		tail = testLogsDefaultTail
	}
	if tail > testLogsMaxTail {
		tail = testLogsMaxTail
	}

	mgr := s.Tests.Manager(projectRoot)
	v := hydratests.Version{Ref: *head.Branch}
	rep, ok, err := mgr.Peek(runner, v)
	if err != nil {
		return reviewq.Result{Message: fmt.Sprintf("The %q runner's state could not be read: %v", runner, err)}
	}
	if !ok {
		return reviewq.Result{Message: fmt.Sprintf("The %q runner has not run for this commit, so there is no log. (If that name looks wrong, call get_head_status for the configured runners.)", runner)}
	}
	if rep.Status == hydratests.StatusRunning {
		// An in-flight run's log lives in memory on the Manager, not on disk yet.
		return reviewq.Result{OK: true, Message: fmt.Sprintf("The %q runner is still RUNNING%s. Its log is only persisted once it settles - ask again shortly.", runner, progressSuffix(rep.Progress))}
	}
	lines, found := mgr.ReadLog(runner, rep.Key)
	if !found || len(lines) == 0 {
		return reviewq.Result{OK: true, Message: fmt.Sprintf("The %q runner has a %s verdict for this commit but captured no output.", runner, rep.Status)}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Output of the %q runner (%s) for branch %s.\n", runner, rep.Status, deref(head.Branch))
	if len(lines) > tail {
		fmt.Fprintf(&b, "Showing the LAST %d of %d lines (a failure is almost always at the end; pass a bigger \"tail\" for more, up to %d).\n", tail, len(lines), testLogsMaxTail)
		lines = lines[len(lines)-tail:]
	} else {
		fmt.Fprintf(&b, "%d lines (the whole log).\n", len(lines))
	}
	b.WriteString("\n")
	for _, l := range lines {
		if l.Stream == hydratests.StreamStderr {
			b.WriteString("stderr| ")
		}
		b.WriteString(l.Text)
		b.WriteString("\n")
	}
	return reviewq.Result{OK: true, Message: b.String()}
}

// runTestsText discards this head's cached verdicts for its branch tip and starts
// fresh runs, for the run_tests tool. It returns as soon as the work is QUEUED:
// a suite can take minutes, and an agent blocked in a tool call for that long is
// worse than one that polls get_head_status.
//
// This is the one place an agent can spend the user's CPU, so it declines rather
// than duplicating work: a run already in flight is left alone, and one that
// settled seconds ago is reported instead of repeated.
func (s *Server) runTestsText(ctx context.Context, id string, req reviewq.Request) reviewq.Result {
	head, projectRoot, errMsg := s.headForStatus(ctx, id)
	if errMsg != "" {
		return reviewq.Result{Message: errMsg}
	}
	if s.Tests == nil || head.Branch == nil {
		return reviewq.Result{Message: "Tests are not available for this head, so there is nothing to run."}
	}
	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return reviewq.Result{Message: "The project config could not be read, so the test runners are unknown."}
	}
	v := hydratests.Version{Ref: *head.Branch}
	runners := s.testRunnersFor(projectRoot, v, liveCfg)
	if len(runners) == 0 {
		return reviewq.Result{OK: true, Message: "This project configures no test runners, so there is nothing to run."}
	}
	want := strings.TrimSpace(req.Runner)
	if want != "" && !slices.ContainsFunc(runners, func(r config.TestScript) bool { return r.Name == want }) {
		return reviewq.Result{Message: fmt.Sprintf("There is no %q runner. This project configures: %s.", want, runnerNames(runners))}
	}

	mgr := s.Tests.Manager(projectRoot)
	var started, skipped []string
	for _, r := range runners {
		if want != "" && r.Name != want {
			continue
		}
		rep, cached, perr := mgr.Peek(r.Name, v)
		switch {
		case perr != nil:
			skipped = append(skipped, fmt.Sprintf("%s (could not be read: %v)", r.Name, perr))
			continue
		case cached && rep.Status == hydratests.StatusRunning:
			skipped = append(skipped, r.Name+" (already running)")
			continue
		case cached && rep.UpdatedAt > 0 && time.Since(time.Unix(rep.UpdatedAt, 0)) < runCooldown:
			skipped = append(skipped, fmt.Sprintf("%s (just ran - it is %s)", r.Name, rep.Status))
			continue
		}
		if err := mgr.Invalidate(r.Name, v); err != nil {
			skipped = append(skipped, fmt.Sprintf("%s (could not be reset: %v)", r.Name, err))
			continue
		}
		if _, err := mgr.Get(r, v); err != nil {
			skipped = append(skipped, fmt.Sprintf("%s (failed to start: %v)", r.Name, err))
			continue
		}
		started = append(started, r.Name)
	}
	return reviewq.Result{OK: true, Message: startedText("test runner", started, skipped)}
}

// runArtifactsText is run_tests' counterpart for [artifacts.<name>] scripts.
// Server ("preview") scripts are excluded for the same reason get_head_status
// omits them: they are a live user-facing affordance, not a generated output.
func (s *Server) runArtifactsText(ctx context.Context, id string, req reviewq.Request) reviewq.Result {
	head, projectRoot, errMsg := s.headForStatus(ctx, id)
	if errMsg != "" {
		return reviewq.Result{Message: errMsg}
	}
	if s.Artifacts == nil || head.Branch == nil {
		return reviewq.Result{Message: "Artifacts are not available for this head, so there is nothing to generate."}
	}
	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return reviewq.Result{Message: "The project config could not be read, so the artifact scripts are unknown."}
	}
	v := artifacts.Version{Ref: *head.Branch}
	specs, err := artifactSpecsByName(projectRoot, v, liveCfg)
	if err != nil {
		return reviewq.Result{Message: "The artifact scripts could not be resolved: " + err.Error()}
	}
	for name := range disabledArtifacts(liveCfg) {
		delete(specs, name)
	}
	if len(specs) == 0 {
		return reviewq.Result{OK: true, Message: "This project configures no artifacts, so there is nothing to generate."}
	}
	want := strings.TrimSpace(req.Runner)
	if want != "" {
		if _, ok := specs[want]; !ok {
			return reviewq.Result{Message: fmt.Sprintf("There is no %q artifact. This project configures: %s.", want, sortedNames(specs))}
		}
	}

	mgr := s.Artifacts.Manager(projectRoot)
	var started, skipped []string
	for _, name := range sortedKeys(specs) {
		if want != "" && name != want {
			continue
		}
		meta, cached, perr := mgr.Peek(name, v)
		switch {
		case perr != nil:
			skipped = append(skipped, fmt.Sprintf("%s (could not be read: %v)", name, perr))
			continue
		case cached && meta.Status == artifacts.StatusGenerating:
			skipped = append(skipped, name+" (already generating)")
			continue
		case cached && meta.UpdatedAt > 0 && time.Since(time.Unix(meta.UpdatedAt, 0)) < runCooldown:
			skipped = append(skipped, name+" (just generated)")
			continue
		}
		if err := mgr.Invalidate(name, v); err != nil {
			skipped = append(skipped, fmt.Sprintf("%s (could not be reset: %v)", name, err))
			continue
		}
		spec := specs[name]
		if _, err := mgr.Get(spec, v); err != nil {
			skipped = append(skipped, fmt.Sprintf("%s (failed to start: %v)", name, err))
			continue
		}
		started = append(started, name)
	}
	return reviewq.Result{OK: true, Message: startedText("artifact", started, skipped)}
}

// startedText reports what was kicked off and what was declined. It always tells
// the agent to poll rather than wait, because nothing here blocks on the work.
func startedText(kind string, started, skipped []string) string {
	var b strings.Builder
	if len(started) > 0 {
		fmt.Fprintf(&b, "Started %d %s(s): %s.\nThis runs in the background - call get_head_status in a little while for the result; do NOT call this again in the meantime.\n",
			len(started), kind, strings.Join(started, ", "))
	}
	if len(skipped) > 0 {
		fmt.Fprintf(&b, "Left alone: %s.\n", strings.Join(skipped, "; "))
	}
	if b.Len() == 0 {
		return "Nothing to do."
	}
	return b.String()
}

func runnerNames(runners []config.TestScript) string {
	names := make([]string, 0, len(runners))
	for _, r := range runners {
		names = append(names, r.Name)
	}
	return strings.Join(names, ", ")
}

func sortedKeys(specs map[string]config.ArtifactScript) []string {
	names := make([]string, 0, len(specs))
	for name := range specs {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func sortedNames(specs map[string]config.ArtifactScript) string {
	return strings.Join(sortedKeys(specs), ", ")
}

// headForStatus resolves a head for a status request. The returned string is a
// ready-to-return explanation when the head can't be resolved (the agent gets a
// reason, not a bare failure).
func (s *Server) headForStatus(ctx context.Context, id string) (*heads.Head, string, string) {
	if s.DB == nil {
		return nil, "", "Hydra has no database open, so your status could not be read."
	}
	a, err := s.DB.GetAgent(id)
	if err != nil || a == nil {
		return nil, "", "This head is no longer known to Hydra, so its status could not be read."
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, a.ProjectPath, id)
	if err != nil || head == nil {
		return nil, "", "This head could not be loaded, so its status could not be read."
	}
	return head, a.ProjectPath, ""
}

// progressSuffix renders a live progress line as a trailing clause, or nothing.
func progressSuffix(progress string) string {
	if p := oneLine(progress, headStatusMessageLen); p != "" {
		return " - " + p
	}
	return ""
}

// oneLine flattens text to a single truncated line, so one runaway assertion
// message can't reflow the whole status answer.
func oneLine(text string, max int) string {
	t := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", " "), "\n", " "))
	t = strings.Join(strings.Fields(t), " ")
	if len(t) > max {
		return t[:max] + "..."
	}
	return t
}

func deref(s *string) string {
	if s == nil {
		return "(none)"
	}
	return *s
}
