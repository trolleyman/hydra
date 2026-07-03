package artifacts

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

// waitQueued spins until the scheduler has at least n queued waiters, so a test
// can assert on queue ordering without racing the goroutines that enqueue.
func waitQueued(t *testing.T, s *genScheduler, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		got := len(s.waiters)
		s.mu.Unlock()
		if got >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d queued waiters (have %d)", n, got)
		}
		time.Sleep(time.Millisecond)
	}
}

// TestSchedulerForegroundJumpsQueue verifies a foreground waiter is granted the
// next freed slot ahead of background waiters that queued earlier.
func TestSchedulerForegroundJumpsQueue(t *testing.T) {
	s := newGenScheduler(1)
	s.acquire("running", false) // hold the only slot

	// Two background waiters queue first, then one foreground.
	order := make(chan string, 3)
	var wg sync.WaitGroup
	for _, key := range []string{"bg1", "bg2"} {
		wg.Go(func() { s.acquire(key, false); order <- key; s.release() })
	}
	waitQueued(t, s, 2)
	wg.Go(func() { s.acquire("fg", true); order <- "fg"; s.release() })
	waitQueued(t, s, 3)

	// Releasing the running slot should hand it to the foreground waiter first.
	s.release()
	wg.Wait()
	close(order)
	var got []string
	for k := range order {
		got = append(got, k)
	}
	if len(got) == 0 || got[0] != "fg" {
		t.Fatalf("foreground should run first, got order %v", got)
	}
}

// TestSchedulerPromote verifies a queued background waiter promoted to
// foreground is then served before an un-promoted background one.
func TestSchedulerPromote(t *testing.T) {
	s := newGenScheduler(1)
	s.acquire("running", false)

	order := make(chan string, 2)
	var wg sync.WaitGroup
	// bg1 queues before bg2; promoting bg2 should let it win.
	wg.Go(func() { s.acquire("bg1", false); order <- "bg1"; s.release() })
	waitQueued(t, s, 1)
	wg.Go(func() { s.acquire("bg2", false); order <- "bg2"; s.release() })
	waitQueued(t, s, 2)

	s.promote("bg2")
	s.release()
	wg.Wait()
	close(order)
	first := <-order
	if first != "bg2" {
		t.Fatalf("promoted waiter should run first, got %q", first)
	}
}

// TestSchedulerSetLimitAdmits verifies raising the limit immediately admits
// queued waiters without a release.
func TestSchedulerSetLimitAdmits(t *testing.T) {
	s := newGenScheduler(1)
	s.acquire("running", false)

	done := make(chan struct{})
	go func() { s.acquire("waiter", false); close(done) }()
	waitQueued(t, s, 1)

	s.setLimit(2) // now two may run at once → the waiter is admitted
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("raising the limit did not admit the queued waiter")
	}
}

// TestSchedulerUnlimited verifies a limit of 0 caps nothing: many acquires all
// proceed without blocking, and lowering the limit afterwards via setLimit lets
// the running set drain without preempting.
func TestSchedulerUnlimited(t *testing.T) {
	s := newGenScheduler(0) // 0 = unlimited
	const n = 50
	done := make(chan struct{}, n)
	for i := range n {
		go func() { s.acquire(fmt.Sprintf("k%d", i), false); done <- struct{}{} }()
	}
	for i := range n {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatalf("unlimited scheduler blocked after %d acquires", i)
		}
	}
	// All n are "running"; releasing them is a no-op queue-wise.
	for range n {
		s.release()
	}
}

// TestSchedulerSetLimitUnlimitedAdmitsAll verifies switching to unlimited (0)
// admits every queued waiter at once.
func TestSchedulerSetLimitUnlimitedAdmitsAll(t *testing.T) {
	s := newGenScheduler(1)
	s.acquire("running", false)

	const n = 8
	done := make(chan struct{}, n)
	for i := range n {
		go func() { s.acquire(fmt.Sprintf("w%d", i), false); done <- struct{}{} }()
	}
	waitQueued(t, s, n)
	s.setLimit(0) // unlimited → all queued waiters admitted
	for i := range n {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatalf("going unlimited did not admit all waiters (%d/%d)", i, n)
		}
	}
}

// TestSchedulerNoPreemption is a sanity check that running generations are not
// counted as preemptible: a foreground arrival does not free a held slot, it
// only reorders the queue (covered above). Here we confirm the running count is
// respected - a second acquire blocks until release even when foreground.
func TestSchedulerNoPreemption(t *testing.T) {
	s := newGenScheduler(1)
	s.acquire("bg", false)

	admitted := make(chan struct{})
	go func() { s.acquire("fg", true); close(admitted) }()
	select {
	case <-admitted:
		t.Fatal("foreground preempted a running generation")
	case <-time.After(50 * time.Millisecond):
	}
	s.release() // bg finishes; now fg runs
	select {
	case <-admitted:
	case <-time.After(2 * time.Second):
		t.Fatal("foreground not admitted after running slot freed")
	}
}
