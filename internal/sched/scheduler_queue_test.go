package sched

import (
	"sync"
	"testing"
	"time"
)

// QueuePosition is what lets the UI tell "waiting behind other work" from
// "running", so it has to report the order slots will actually be handed out in -
// foreground first, then FIFO - and report 0 for anything holding a slot.
func TestQueuePosition(t *testing.T) {
	s := New(1)

	// Take the only slot. Nothing is queued behind it yet.
	s.Acquire("running", false)
	if got := s.QueuePosition("running"); got != 0 {
		t.Errorf("a running entry reported queue position %d, want 0", got)
	}
	if got := s.QueuePosition("never-heard-of-it"); got != 0 {
		t.Errorf("an unknown key reported %d, want 0", got)
	}

	// Queue three behind it: two background, then one foreground. The foreground
	// one jumps both, so it must report position 1 even though it arrived last.
	//
	// Each waiter is parked before the next one is started. Ties among equal
	// priority are broken by arrival order, and goroutines started together park
	// in whatever order the runtime happens to run them - not the order they were
	// created in - so starting bg1 and bg2 concurrently would leave the order
	// between them undefined.
	var wg sync.WaitGroup
	queue := func(key string, fg bool, want int) {
		t.Helper()
		wg.Go(func() { s.Acquire(key, fg); s.Release() })
		waitForWaiters(t, s, want)
	}
	queue("bg1", false, 1)
	queue("bg2", false, 2)
	queue("fg", true, 3)

	if got := s.QueuePosition("fg"); got != 1 {
		t.Errorf("foreground reported position %d, want 1 (it jumps the queue)", got)
	}
	if got := s.QueuePosition("bg1"); got != 2 {
		t.Errorf("first background reported %d, want 2", got)
	}
	if got := s.QueuePosition("bg2"); got != 3 {
		t.Errorf("second background reported %d, want 3", got)
	}

	// Promoting a background waiter moves it up the reported order too - otherwise
	// the UI would keep showing a stale place in the queue. It lands AHEAD of the
	// earlier foreground waiter, because promotion only changes priority and ties
	// among equal priority are still broken by arrival order: bg2 was queued
	// before fg, so once both are foreground bg2 goes first.
	s.Promote("bg2")
	if got := s.QueuePosition("bg2"); got != 1 {
		t.Errorf("promoted background reported %d, want 1 (it was queued before fg)", got)
	}
	if got := s.QueuePosition("fg"); got != 2 {
		t.Errorf("foreground reported %d after an earlier waiter was promoted, want 2", got)
	}

	s.Release() // hand the slot on; the queue drains
	wg.Wait()
	if got := s.QueuePosition("fg"); got != 0 {
		t.Errorf("a drained queue still reported position %d, want 0", got)
	}
}

// waitForWaiters blocks until exactly n acquires are parked, so the test doesn't
// race the goroutines it just started.
func waitForWaiters(t *testing.T, s *Scheduler, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		got := len(s.waiters)
		s.mu.Unlock()
		if got == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d queued waiters (have %d)", n, got)
		}
		time.Sleep(time.Millisecond)
	}
}
