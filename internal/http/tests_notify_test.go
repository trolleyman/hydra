package http

import "testing"

// Dedup alone does not bound the fix-fail-fix cycle: every attempt is a new
// commit, so every attempt is genuinely new news. The streak cap is what stops it,
// and a human (or a green suite) is what restarts the conversation.
func TestTestNotifyStreakBoundsTheLoop(t *testing.T) {
	head := "loop-head"
	ForgetTestNotifications(head)
	t.Cleanup(func() { ForgetTestNotifications(head) })

	// Each "commit" is a new key, exactly as a real fix attempt would be.
	for i := range testNotifyMaxStreak {
		if !markTestNotified(head, "go", commitKey(i)) {
			t.Fatalf("report %d was suppressed; the first %d must get through", i+1, testNotifyMaxStreak)
		}
	}
	if markTestNotified(head, "go", commitKey(99)) {
		t.Fatal("the streak cap did not stop the loop")
	}

	// A human speaking (or the suite going green) restarts it.
	ResetTestNotifyStreak(head)
	if !markTestNotified(head, "go", commitKey(100)) {
		t.Fatal("resetting the streak did not restore the allowance")
	}
}

// The same verdict twice is the same news, cap or no cap.
func TestTestNotifyDedupesTheSameVerdict(t *testing.T) {
	head := "dedup-head"
	ForgetTestNotifications(head)
	t.Cleanup(func() { ForgetTestNotifications(head) })

	if !markTestNotified(head, "go", "commit/abc") {
		t.Fatal("the first report should send")
	}
	if markTestNotified(head, "go", "commit/abc") {
		t.Error("the same (runner, commit) reported twice")
	}
	// A different runner failing on the same commit IS separate news.
	if !markTestNotified(head, "eslint", "commit/abc") {
		t.Error("a different runner on the same commit was swallowed")
	}
}

func commitKey(i int) string { return "commit/" + string(rune('a'+i%26)) + string(rune('0'+i/26)) }
