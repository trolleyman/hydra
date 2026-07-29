package heads

import (
	"strings"
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
		{"sandboxed with token", "abc", true, "bash-123", "abc@shell-bash-123"},
		{"host with token", "abc", false, "bash-123", "abc@shell-host-bash-123"},
		{"no token", "abc", true, "", "abc@shell"},
		{"token sanitized", "abc", true, "../../etc/passwd", "abc@shell-etcpasswd"},
		{"token slashes dropped", "abc", false, "a/b\\c", "abc@shell-host-abc"},
	}
	for _, c := range cases {
		if got := ShellSessionID(c.head, c.sandboxed, c.token); got != c.want {
			t.Errorf("%s: ShellSessionID(%q,%v,%q) = %q, want %q", c.name, c.head, c.sandboxed, c.token, got, c.want)
		}
	}
}

// A slot ID must never be spellable as a head ID, or one head's SlotPrefix sweep
// tears down another head's sessions. SlotSep is the guarantee: ValidateHeadID
// rejects it, so no head can be named `<other-head>@shell`.
func TestSlotSepIsNotAValidHeadID(t *testing.T) {
	if err := ValidateHeadID(SlotSessionID("foo", "shell")); err == nil {
		t.Fatalf("ValidateHeadID(%q) = nil, want an error: a head must never be nameable as another head's slot",
			SlotSessionID("foo", "shell"))
	}
	// The separator itself must be outside the explicit-ID character class, not
	// merely absent from generated slugs.
	if err := ValidateHeadID("a" + SlotSep + "b"); err == nil {
		t.Errorf("ValidateHeadID accepts SlotSep %q; pick a character it rejects", SlotSep)
	}
}

// The SlotPrefix sweep must not catch a different head whose ID merely starts
// with this head's ID. Two cases, and the second is the one the old `<head>-shell`
// scheme got wrong: "foo" vs "foobar" was safe because of the "-shell" boundary,
// but "fix-the" vs "fix-the-shell-script" was NOT - killing the former swept the
// latter's main agent session, whose session ID is just its head ID.
func TestSlotPrefixDoesNotCatchOtherHeads(t *testing.T) {
	cases := []struct{ killing, other string }{
		{"foo", "foobar"},
		{"fix-the", "fix-the-shell-script"},
		{"fix-the", "fix-the-shell"},
	}
	for _, c := range cases {
		prefix := SlotPrefix(c.killing)
		// The other head's own agent session is keyed by its bare head ID.
		if strings.HasPrefix(c.other, prefix) {
			t.Errorf("killing %q sweeps prefix %q, which matches head %q's agent session", c.killing, prefix, c.other)
		}
		// ...and so are its slots.
		if other := ShellSessionID(c.other, true, "t"); strings.HasPrefix(other, prefix) {
			t.Errorf("killing %q sweeps prefix %q, which matches %q's shell %q", c.killing, prefix, c.other, other)
		}
		// The sweep must still catch the head's own slots.
		if own := ShellSessionID(c.killing, true, "t"); !strings.HasPrefix(own, prefix) {
			t.Errorf("killing %q: own shell %q not matched by prefix %q", c.killing, own, prefix)
		}
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
