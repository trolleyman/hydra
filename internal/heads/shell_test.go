package heads

import (
	"sync"
	"testing"
)

func TestShellSessionID(t *testing.T) {
	cases := []struct {
		name      string
		head      string
		sandboxed bool
		token     string
		want      string
	}{
		{"sandboxed with token", "abc", true, "bash-123", "abc-shell-bash-123"},
		{"host with token", "abc", false, "bash-123", "abc-shell-host-bash-123"},
		{"no token", "abc", true, "", "abc-shell"},
		{"token sanitized", "abc", true, "../../etc/passwd", "abc-shell-etcpasswd"},
		{"token slashes dropped", "abc", false, "a/b\\c", "abc-shell-host-abc"},
	}
	for _, c := range cases {
		if got := ShellSessionID(c.head, c.sandboxed, c.token); got != c.want {
			t.Errorf("%s: ShellSessionID(%q,%v,%q) = %q, want %q", c.name, c.head, c.sandboxed, c.token, got, c.want)
		}
	}
}

// The KillMatching("<head>-shell") sweep must not catch a different head whose ID
// merely starts with this head's ID (e.g. "foo" vs "foobar"): the "-shell"
// boundary keeps the prefix unambiguous.
func TestShellSessionIDPrefixBoundary(t *testing.T) {
	foo := ShellSessionID("foo", true, "t")
	foobar := ShellSessionID("foobar", true, "t")
	if prefix := "foo" + "-shell"; len(foobar) >= len(prefix) && foobar[:len(prefix)] == prefix {
		t.Errorf("foobar shell %q wrongly matches prefix %q", foobar, prefix)
	}
	if prefix := "foo" + "-shell"; foo[:len(prefix)] != prefix {
		t.Errorf("foo shell %q should match prefix %q", foo, prefix)
	}
}

// The shell-start gate must serialize concurrent starts for the same ID (so two
// racing WebSocket connections for one terminal tab can never both drive the
// start path, which is what produced "session already exists"), while letting
// different IDs proceed independently.
func TestShellStartGateSerializes(t *testing.T) {
	const goroutines = 50
	var (
		start   sync.WaitGroup
		done    sync.WaitGroup
		active  int
		maxSeen int
		mu      sync.Mutex
	)
	start.Add(1)
	for range goroutines {
		done.Go(func() {
			start.Wait()
			g := acquireShellStart("same-id")
			g.mu.Lock()
			mu.Lock()
			active++
			if active > maxSeen {
				maxSeen = active
			}
			active--
			mu.Unlock()
			g.mu.Unlock()
			releaseShellStart("same-id")
		})
	}
	start.Done()
	done.Wait()

	if maxSeen != 1 {
		t.Errorf("max concurrent holders of one shell gate = %d, want 1", maxSeen)
	}
	// Every reference released, so the gate is dropped from the map.
	shellStartGates.mu.Lock()
	n := len(shellStartGates.m)
	shellStartGates.mu.Unlock()
	if n != 0 {
		t.Errorf("shellStartGates not emptied after release: %d entries left", n)
	}
}

// Different shell IDs get independent gates, so an unrelated tab never blocks on
// another's in-flight start.
func TestShellStartGateDistinctIDs(t *testing.T) {
	a := acquireShellStart("id-a")
	a.mu.Lock()
	// A different ID must be acquirable and lockable without blocking on id-a.
	b := acquireShellStart("id-b")
	if !b.mu.TryLock() {
		t.Fatal("distinct shell ID blocked on an unrelated gate")
	}
	b.mu.Unlock()
	releaseShellStart("id-b")
	a.mu.Unlock()
	releaseShellStart("id-a")
}
