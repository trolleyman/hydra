package heads

import (
	"testing"
	"time"
)

func TestStatusTimeAfter(t *testing.T) {
	cases := []struct {
		name string
		a, b string
		want bool
	}{
		{"empty b loses to valid a", "2026-06-15T10:00:00Z", "", true},
		{"invalid a never wins", "", "2026-06-15T10:00:00Z", false},
		{"strictly later", "2026-06-15T10:00:01Z", "2026-06-15T10:00:00Z", true},
		{"equal is not after", "2026-06-15T10:00:00Z", "2026-06-15T10:00:00Z", false},
		// Same wall-clock second, distinguished only by nanoseconds — the case
		// that left agents stuck in "starting".
		{"nano breaks same-second tie", "2026-06-15T10:00:00.200Z", "2026-06-15T10:00:00.100Z", true},
		// Trailing-zero trimming would make ".5" sort after ".50001" lexically;
		// parsing keeps it correct.
		{"trimmed fraction ordered numerically", "2026-06-15T10:00:00.50001Z", "2026-06-15T10:00:00.5Z", true},
	}
	for _, c := range cases {
		if got := statusTimeAfter(c.a, c.b); got != c.want {
			t.Errorf("%s: statusTimeAfter(%q,%q) = %v, want %v", c.name, c.a, c.b, got, c.want)
		}
	}
}

func TestUnreadDebouncerMaturesAfterGrace(t *testing.T) {
	d := newUnreadDebouncer()
	t0 := time.Unix(1000, 0)
	d.arm("a", "finished", t0)

	if d.ready("a", "finished", t0) {
		t.Fatal("fired immediately on arm; should wait for the grace window")
	}
	if d.ready("a", "finished", t0.Add(graceUnread-time.Millisecond)) {
		t.Fatal("fired just before the grace window elapsed")
	}
	if !d.ready("a", "finished", t0.Add(graceUnread)) {
		t.Fatal("did not fire once the grace window elapsed")
	}
	// ready clears the entry after firing, so it does not fire again.
	if d.ready("a", "finished", t0.Add(2*graceUnread)) {
		t.Fatal("fired twice for one transition")
	}
}

func TestUnreadDebouncerCancelledByResumedActivity(t *testing.T) {
	// The delegation-blip case: a head writes "finished" when its turn ends to
	// await a background subagent, then the subagent's next tool hook resets the
	// status to running before the grace window elapses. The pending flag must be
	// cancelled so no spurious unread dot latches.
	d := newUnreadDebouncer()
	t0 := time.Unix(2000, 0)
	d.arm("a", "finished", t0)

	// Activity resumed within the window — the poller forgets it.
	d.forget("a")

	if d.ready("a", "finished", t0.Add(2*graceUnread)) {
		t.Fatal("matured after activity resumed; the blip should have been cancelled")
	}
}

func TestUnreadDebouncerStatusChangeClearsPending(t *testing.T) {
	// If the status drifts to a different deferred state, the original pending
	// entry must not fire for the new status.
	d := newUnreadDebouncer()
	t0 := time.Unix(3000, 0)
	d.arm("a", "finished", t0)

	if d.ready("a", "waiting", t0.Add(graceUnread)) {
		t.Fatal("fired for a status it was not armed for")
	}
	// And the stale entry was cleared.
	if d.ready("a", "finished", t0.Add(2*graceUnread)) {
		t.Fatal("stale entry survived a status mismatch")
	}
}

func TestUnreadDebouncerTakeRaisesOnSessionExit(t *testing.T) {
	// An agent that finishes and then exits before the grace window elapses: the
	// poller calls take() when it sees the session gone. A pending entry means a
	// real finish the window had not yet confirmed, so take reports it (and the
	// caller raises the flag) — the session ending is itself the confirmation.
	d := newUnreadDebouncer()
	t0 := time.Unix(5000, 0)
	d.arm("a", "finished", t0)

	if !d.take("a") {
		t.Fatal("take did not report the pending unread on session exit")
	}
	// take clears the entry, so a later poll (and ready) does not double-fire.
	if d.take("a") {
		t.Fatal("take fired twice for one transition")
	}
	if d.ready("a", "finished", t0.Add(2*graceUnread)) {
		t.Fatal("ready matured after take already consumed the pending entry")
	}
}

func TestUnreadDebouncerTakeNoPending(t *testing.T) {
	// No transition was pending (e.g. the agent was killed from running, or its
	// flag already matured) — a session exit must not raise a spurious dot.
	d := newUnreadDebouncer()
	if d.take("a") {
		t.Fatal("take reported a pending entry that was never armed")
	}
}

func TestUnreadDebouncerArmPreservesOriginalSince(t *testing.T) {
	// Re-arming the same status across polls must keep counting from the first
	// observation, not restart the window each tick.
	d := newUnreadDebouncer()
	t0 := time.Unix(4000, 0)
	d.arm("a", "finished", t0)
	d.arm("a", "finished", t0.Add(graceUnread-time.Second)) // a later poll, same status

	if !d.ready("a", "finished", t0.Add(graceUnread)) {
		t.Fatal("re-arming restarted the grace window instead of preserving it")
	}
}
