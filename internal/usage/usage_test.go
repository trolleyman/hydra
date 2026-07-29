package usage

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"braces.dev/errtrace"
)

// sampleScreenReader is the `/usage` screen as the CLI renders it under
// --ax-screen-reader (captured from Claude Code 2.1.220, trimmed). Note the two
// things that broke the original parser: the percentage appears twice on a line
// (the bar's own label, then the readout), and the session reset is a wall clock
// time rather than a countdown.
const sampleScreenReader = `Claude Code v2.1.220
Opus 5 (1M context) · Claude Max
~/code/hydra
you: /usage
Settings  Status   Config   Usage   Stats
Session
Total cost:            $0.0000
Current session
72% 72% used
Resets 3:10pm (Europe/London)
Current week (all models)
55% 55% used
Resets Aug 2, 4pm (Europe/London)
+50% weekly limits promo through Aug 19 · clau.de/cc-50-promo
Current week (Fable)
2% 2% used
Resets Aug 2, 3:59pm (Europe/London)
What's contributing to your limits usage?
Usage credits
Usage credits are off · /usage-credits to turn them on
Esc to cancel
`

// sampleUsage mirrors the older boxed `/usage` screen, which stated the session
// reset as a countdown. Both forms are still parsed.
const sampleUsage = `Opus 4.5 · Claude Max · user@example.com's Organization

Current session
████████████████░░░░ 65% left
Resets in 2h 15m

Current week (all models)
██████████░░░░░░░░░░ 35% left
Resets Jan 15, 3:30pm (America/Los_Angeles)

Current week (Opus)
████████████████████ 80% left
Resets Jan 15, 3:30pm (America/Los_Angeles)
`

// sampleUsedForm uses the "% used" phrasing instead of "% left".
const sampleUsedForm = `Current session
████████████████████ 25% used
Resets in 30m

Current week (all models)
████████████░░░░░░░░ 60% used
Resets Jan 18, 9:00am
`

func pct(v *float64) float64 {
	if v == nil {
		return -1
	}
	return *v
}

func TestParseScreenReaderForm(t *testing.T) {
	london, err := time.LoadLocation("Europe/London")
	if err != nil {
		t.Skipf("no tzdata for Europe/London: %v", err)
	}
	now := time.Date(2026, 7, 29, 14, 30, 0, 0, london)
	s := Parse(sampleScreenReader, now)

	if !s.Available {
		t.Fatalf("expected available snapshot, got error %q", s.Error)
	}
	if !s.Complete() {
		t.Error("expected a complete snapshot (both quota bars read)")
	}
	if got := pct(s.SessionPercentUsed); got != 72 {
		t.Errorf("session used = %v, want 72", got)
	}
	// The weekly block must not pick up the neighbouring "Current week (Fable)"
	// bar, nor the "+50% weekly limits promo" line.
	if got := pct(s.WeeklyPercentUsed); got != 55 {
		t.Errorf("weekly used = %v, want 55", got)
	}
	if s.SessionResetsAt == nil {
		t.Fatal("expected the wall-clock session reset to resolve")
	}
	want := time.Date(2026, 7, 29, 15, 10, 0, 0, london)
	if !s.SessionResetsAt.Equal(want) {
		t.Errorf("session resetsAt = %v, want %v", s.SessionResetsAt, want)
	}
	if !strings.Contains(s.WeeklyResetText, "Aug 2") {
		t.Errorf("weekly reset text = %q, want it to mention Aug 2", s.WeeklyResetText)
	}
	if s.AccountTier != "Claude Max" {
		t.Errorf("tier = %q, want Claude Max", s.AccountTier)
	}
}

// A wall-clock reset that has already passed today is tomorrow's.
func TestParseWallClockResetRollsOver(t *testing.T) {
	london, err := time.LoadLocation("Europe/London")
	if err != nil {
		t.Skipf("no tzdata for Europe/London: %v", err)
	}
	now := time.Date(2026, 7, 29, 18, 0, 0, 0, london)
	s := Parse(sampleScreenReader, now)
	if s.SessionResetsAt == nil {
		t.Fatal("expected a resolved session reset")
	}
	want := time.Date(2026, 7, 30, 15, 10, 0, 0, london)
	if !s.SessionResetsAt.Equal(want) {
		t.Errorf("session resetsAt = %v, want %v (tomorrow)", s.SessionResetsAt, want)
	}
}

func TestParseLeftForm(t *testing.T) {
	now := time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC)
	s := Parse(sampleUsage, now)

	if !s.Available {
		t.Fatalf("expected available snapshot, got error %q", s.Error)
	}
	if got := pct(s.SessionPercentUsed); got != 35 {
		t.Errorf("session used = %v, want 35 (100-65)", got)
	}
	if got := pct(s.WeeklyPercentUsed); got != 65 {
		t.Errorf("weekly used = %v, want 65 (100-35)", got)
	}
	if s.SessionResetsAt == nil {
		t.Fatal("expected session resets-at to be computed")
	}
	want := now.Add(2*time.Hour + 15*time.Minute)
	if !s.SessionResetsAt.Equal(want) {
		t.Errorf("session resetsAt = %v, want %v", s.SessionResetsAt, want)
	}
	if s.SessionResetText != "Resets in 2h 15m" {
		t.Errorf("session reset text = %q", s.SessionResetText)
	}
	if s.AccountTier != "Claude Max" {
		t.Errorf("tier = %q, want Claude Max", s.AccountTier)
	}
}

func TestParseUsedForm(t *testing.T) {
	now := time.Date(2026, 1, 18, 8, 0, 0, 0, time.UTC)
	s := Parse(sampleUsedForm, now)

	if !s.Available {
		t.Fatalf("expected available, got %q", s.Error)
	}
	if got := pct(s.SessionPercentUsed); got != 25 {
		t.Errorf("session used = %v, want 25", got)
	}
	if got := pct(s.WeeklyPercentUsed); got != 60 {
		t.Errorf("weekly used = %v, want 60", got)
	}
	if s.SessionResetsAt == nil || !s.SessionResetsAt.Equal(now.Add(30*time.Minute)) {
		t.Errorf("session resetsAt = %v, want +30m", s.SessionResetsAt)
	}
}

func TestParseSubscriptionRequired(t *testing.T) {
	out := "Usage tracking is only available for subscription plans. Run /cost instead."
	s := Parse(out, time.Now())
	if s.Available {
		t.Error("expected unavailable for API-billing account")
	}
	if s.Error == "" {
		t.Error("expected an explanatory error")
	}
	if !s.Permanent {
		t.Error("a non-subscription account can't be fixed by re-probing; expected Permanent")
	}
}

func TestParseGarbage(t *testing.T) {
	s := Parse("some unrelated screen with no quota", time.Now())
	if s.Available {
		t.Error("expected unavailable for unparseable output")
	}
	if s.Error == "" {
		t.Error("expected a parse error message")
	}
	if s.Permanent {
		t.Error("an unreadable screen may just be a slow render; expected not Permanent")
	}
}

// okSnap is a minimal usable snapshot for cache tests.
func okSnap(v float64) Snapshot {
	return Snapshot{Available: true, SessionPercentUsed: &v}
}

// testPolicy keeps the intervals tiny so cache tests don't sleep.
func testPolicy() Policy {
	return Policy{
		TTL:            time.Minute,
		MinInterval:    time.Nanosecond,
		FailureBackoff: time.Minute,
		MaxBackoff:     time.Hour,
		MaxFailures:    3,
	}
}

func TestCacheServesFreshAndForces(t *testing.T) {
	var calls int
	p := testPolicy()
	c := NewCache(p, func(context.Context) (Snapshot, error) {
		calls++
		return okSnap(float64(calls)), nil
	})

	if _, err := c.Get(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	// Within ttl, no re-probe.
	if _, err := c.Get(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("expected 1 probe within ttl, got %d", calls)
	}
	// force re-probes.
	if _, err := c.Get(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("expected force to re-probe, calls=%d", calls)
	}
}

func TestCacheMinIntervalThrottlesForcedProbes(t *testing.T) {
	var calls int
	p := testPolicy()
	p.MinInterval = time.Hour
	c := NewCache(p, func(context.Context) (Snapshot, error) {
		calls++
		return okSnap(1), nil
	})

	for range 5 {
		if _, err := c.Get(context.Background(), true); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("MinInterval should cap repeated forced probes at 1, got %d", calls)
	}
}

func TestCacheServesStaleOnError(t *testing.T) {
	var calls int
	p := testPolicy()
	p.TTL = 0 // NewCache substitutes the default; force below drives re-probes
	c := NewCache(p, func(context.Context) (Snapshot, error) {
		calls++
		if calls == 1 {
			return okSnap(10), nil
		}
		return Snapshot{}, errtrace.Wrap(context.DeadlineExceeded)
	})

	first, err := c.Get(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.Get(context.Background(), true)
	if err != nil {
		t.Fatalf("expected stale fallback, got error %v", err)
	}
	if !second.Available || second.SessionPercentUsed == nil || *second.SessionPercentUsed != *first.SessionPercentUsed {
		t.Errorf("expected stale snapshot to match first, got %+v", second)
	}
}

// Repeated failures must back off rather than re-probe on every request.
func TestCacheBacksOffAfterFailure(t *testing.T) {
	var calls int
	c := NewCache(testPolicy(), func(context.Context) (Snapshot, error) {
		calls++
		return Snapshot{}, errtrace.Wrap(context.DeadlineExceeded)
	})

	if _, err := c.Get(context.Background(), false); err == nil {
		t.Error("expected the first failure to surface (nothing cached yet)")
	}
	for range 10 {
		_, _ = c.Get(context.Background(), false)
	}
	if calls != 1 {
		t.Fatalf("expected background polls to be held off by the backoff, got %d probes", calls)
	}
}

// After MaxFailures consecutive failures the probe is parked: no automatic
// attempts at all, however long the caller waits.
func TestCacheParksAfterMaxFailures(t *testing.T) {
	var calls int
	p := testPolicy()
	p.FailureBackoff = time.Nanosecond
	p.MaxBackoff = time.Nanosecond
	c := NewCache(p, func(context.Context) (Snapshot, error) {
		calls++
		return Snapshot{}, errtrace.Wrap(context.DeadlineExceeded)
	})

	for range 10 {
		_, _ = c.Get(context.Background(), false)
	}
	if calls != p.MaxFailures {
		t.Fatalf("expected the probe to park after %d failures, got %d probes", p.MaxFailures, calls)
	}
	// A user-initiated refresh is still allowed through.
	snap, _ := c.Get(context.Background(), true)
	if calls != p.MaxFailures+1 {
		t.Fatalf("expected force to retry a parked probe, got %d probes", calls)
	}
	if snap.Available {
		t.Error("expected the forced retry to report unavailable")
	}
}

// A probe that runs fine but yields nothing usable is a failure too: retrying a
// screen we can't read is exactly the wall this cache exists not to keep hitting.
func TestCacheTreatsUnusableResultAsFailure(t *testing.T) {
	var calls int
	p := testPolicy()
	c := NewCache(p, func(context.Context) (Snapshot, error) {
		calls++
		return Snapshot{Error: "could not parse Claude usage output"}, nil
	})

	for range 10 {
		_, _ = c.Get(context.Background(), false)
	}
	if calls != 1 {
		t.Fatalf("expected an unparseable result to trigger the backoff, got %d probes", calls)
	}
}

// A permanently-unavailable answer (no CLI, no subscription) parks immediately.
func TestCachePermanentFailureParksImmediately(t *testing.T) {
	var calls int
	p := testPolicy()
	p.FailureBackoff = time.Nanosecond
	p.MaxBackoff = time.Nanosecond
	c := NewCache(p, func(context.Context) (Snapshot, error) {
		calls++
		return Snapshot{Error: "claude CLI not found in PATH", Permanent: true}, nil
	})

	for range 10 {
		_, _ = c.Get(context.Background(), false)
	}
	if calls != 1 {
		t.Fatalf("expected a permanent failure to park after one probe, got %d", calls)
	}
}

// Parking is a long backoff, not a death sentence: once ParkedRetry has elapsed
// the probe gets another go on its own, so a CLI that is reinstalled or logged
// back in recovers without the daemon being restarted.
func TestCacheParkedProbeRetriesEventually(t *testing.T) {
	var calls int
	p := testPolicy()
	p.FailureBackoff = time.Nanosecond
	p.MaxBackoff = time.Nanosecond
	p.ParkedRetry = 20 * time.Millisecond
	c := NewCache(p, func(context.Context) (Snapshot, error) {
		calls++
		return Snapshot{}, errtrace.Wrap(context.DeadlineExceeded)
	})

	for range 10 {
		_, _ = c.Get(context.Background(), false)
	}
	if calls != p.MaxFailures {
		t.Fatalf("expected parking after %d failures, got %d probes", p.MaxFailures, calls)
	}
	time.Sleep(2 * p.ParkedRetry)
	_, _ = c.Get(context.Background(), false)
	if calls != p.MaxFailures+1 {
		t.Errorf("expected one attempt after ParkedRetry elapsed, got %d probes", calls)
	}
}

// A recovered probe clears the backoff and the parked flag.
func TestCacheRecovers(t *testing.T) {
	var calls int
	p := testPolicy()
	p.FailureBackoff = time.Nanosecond
	p.MaxBackoff = time.Nanosecond
	c := NewCache(p, func(context.Context) (Snapshot, error) {
		calls++
		if calls <= p.MaxFailures {
			return Snapshot{}, errtrace.Wrap(context.DeadlineExceeded)
		}
		return okSnap(42), nil
	})

	for range 10 {
		_, _ = c.Get(context.Background(), false)
	}
	snap, _ := c.Get(context.Background(), true) // unparks and succeeds
	if !snap.Available {
		t.Fatalf("expected recovery, got %+v", snap)
	}
	before := calls
	for range 5 {
		if _, err := c.Get(context.Background(), false); err != nil {
			t.Fatal(err)
		}
	}
	if calls != before {
		t.Errorf("expected the recovered snapshot to be served from cache, got %d extra probes", calls-before)
	}
}

// A caller arriving while a probe is in flight is served immediately rather than
// queueing behind a multi-second CLI run.
func TestCacheDoesNotBlockConcurrentCallers(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{})
	probed := make(chan struct{}, 4)
	var calls atomic.Int32
	c := NewCache(testPolicy(), func(context.Context) (Snapshot, error) {
		calls.Add(1)
		close(entered)
		<-release
		return okSnap(7), nil
	})

	go func() {
		_, _ = c.Get(context.Background(), false)
		probed <- struct{}{}
	}()
	<-entered

	done := make(chan Snapshot, 1)
	go func() {
		snap, _ := c.Get(context.Background(), true)
		done <- snap
	}()
	select {
	case snap := <-done:
		if snap.Available {
			t.Error("expected the concurrent caller to be served the (empty) cache, not the probe result")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Get blocked behind an in-flight probe")
	}
	close(release)
	<-probed
	if got := calls.Load(); got != 1 {
		t.Errorf("expected probes to coalesce, got %d", got)
	}
}
