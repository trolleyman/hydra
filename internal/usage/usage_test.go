package usage

import (
	"braces.dev/errtrace"
	"context"
	"testing"
	"time"
)

// sampleUsage mirrors the rendered `claude /usage` screen for a Max account.
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
}

func TestParseGarbage(t *testing.T) {
	s := Parse("some unrelated screen with no quota", time.Now())
	if s.Available {
		t.Error("expected unavailable for unparseable output")
	}
	if s.Error == "" {
		t.Error("expected a parse error message")
	}
}

func TestCacheServesFreshAndForces(t *testing.T) {
	var calls int
	c := NewCache(time.Minute, func(context.Context) (Snapshot, error) {
		calls++
		v := float64(calls)
		return Snapshot{Available: true, SessionPercentUsed: &v}, nil
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

func TestCacheServesStaleOnError(t *testing.T) {
	var calls int
	c := NewCache(0, func(context.Context) (Snapshot, error) {
		calls++
		if calls == 1 {
			v := 10.0
			return Snapshot{Available: true, SessionPercentUsed: &v}, nil
		}
		return Snapshot{}, errtrace.Wrap(context.DeadlineExceeded)
	})

	first, err := c.Get(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	// ttl 0 forces a re-probe, which fails; we should get the stale first snap.
	second, err := c.Get(context.Background(), false)
	if err != nil {
		t.Fatalf("expected stale fallback, got error %v", err)
	}
	if !second.Available || second.SessionPercentUsed == nil || *second.SessionPercentUsed != *first.SessionPercentUsed {
		t.Errorf("expected stale snapshot to match first, got %+v", second)
	}
}
