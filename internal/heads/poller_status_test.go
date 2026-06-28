package heads

import (
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/api"
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

func TestIsImmediateWait(t *testing.T) {
	immediate := func(event, notificationType string) bool {
		return isImmediateWait(&StatusFile{
			AgentStatusInfo:  api.AgentStatusInfo{Event: &event},
			NotificationType: notificationType,
		})
	}

	// Tool/permission events that mean the agent is unambiguously blocked on the user.
	for _, e := range []string{"PreToolUse", "preToolUse", "BeforeTool", "PermissionRequest", "permissionRequest"} {
		if !immediate(e, "") {
			t.Errorf("isImmediateWait(event=%q) = false, want true", e)
		}
	}

	// A Notification is immediate only for an explicit prompt, not the idle nudge.
	for _, nt := range []string{"permission_prompt", "elicitation_dialog"} {
		if !immediate("Notification", nt) {
			t.Errorf("isImmediateWait(Notification, %q) = false, want true", nt)
		}
	}
	for _, nt := range []string{"idle_prompt", "auth_success", ""} {
		if immediate("Notification", nt) {
			t.Errorf("isImmediateWait(Notification, %q) = true, want false (deferred)", nt)
		}
	}

	// Non-immediate events.
	for _, e := range []string{"Stop", "SessionStart", ""} {
		if immediate(e, "") {
			t.Errorf("isImmediateWait(event=%q) = true, want false", e)
		}
	}
	if isImmediateWait(nil) {
		t.Error("isImmediateWait(nil) = true, want false")
	}
	if isImmediateWait(&StatusFile{}) {
		t.Error("isImmediateWait(no event) = true, want false")
	}
}
