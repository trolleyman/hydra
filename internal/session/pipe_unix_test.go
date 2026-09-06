//go:build unix

package session

import (
	"bytes"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestStartUsesProtocolSafePipesForChatSessions(t *testing.T) {
	reg := NewRegistry()
	lines := make(chan []byte, 1)
	reg.SetOnChatLine(func(_ string, _ string, line []byte) {
		lines <- append([]byte(nil), line...)
	})
	sess, err := reg.Start(StartOptions{
		ID: "chat",
		Sandbox: sandbox.Options{
			AgentType:    sandbox.AgentTypeClaude,
			WorktreePath: t.TempDir(),
			NoSandbox:    true,
			StdioPipes:   true,
			Argv:         []string{"/bin/sh", "-c", `IFS= read -r line; printf '%s\n' "$line"`},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if sess.Kind != KindChat {
		t.Fatalf("kind = %q, want chat", sess.Kind)
	}
	want := []byte(`{"type":"result"}`)
	if err := reg.Write("chat", append(want, '\n')); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-lines:
		if !bytes.Equal(got, want) {
			t.Fatalf("line = %q, want %q", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for chat line")
	}
}
