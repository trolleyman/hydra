package sandbox

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestNetworkModeSynonyms(t *testing.T) {
	// "on" is an accepted synonym that canonicalises to hard.
	if got := NormalizeNetworkMode("on"); got != NetHard {
		t.Errorf(`NormalizeNetworkMode("on") = %q, want %q`, got, NetHard)
	}
	// Canonical values and empty pass through unchanged.
	for _, m := range []NetworkMode{"", NetOff, NetUnrestricted, NetAdvisory, NetHard} {
		if got := NormalizeNetworkMode(string(m)); got != m {
			t.Errorf("NormalizeNetworkMode(%q) = %q, want %q", m, got, m)
		}
	}
	// Both canonical modes and the "on" synonym validate; junk does not.
	for _, ok := range []string{"", "off", "unrestricted", "advisory", "hard", "on"} {
		if !ValidNetworkMode(ok) {
			t.Errorf("ValidNetworkMode(%q) = false, want true", ok)
		}
	}
	if ValidNetworkMode("bogus") {
		t.Error(`ValidNetworkMode("bogus") = true, want false`)
	}
}

func TestGitIsolationMode(t *testing.T) {
	for _, ok := range []string{"", "off", "refs", "readonly"} {
		if !ValidGitIsolation(ok) {
			t.Errorf("ValidGitIsolation(%q) = false, want true", ok)
		}
	}
	if ValidGitIsolation("bogus") {
		t.Error(`ValidGitIsolation("bogus") = true, want false`)
	}
	// Only the refs-locked modes require host-mediated commits.
	for m, want := range map[GitIsolationMode]bool{
		GitIsolationOff: false, GitIsolationRefs: true, GitIsolationReadonly: true,
	} {
		if got := m.HostMediatedCommit(); got != want {
			t.Errorf("%q.HostMediatedCommit() = %v, want %v", m, got, want)
		}
	}
}

func TestExpandPath(t *testing.T) {
	home := "/home/u"
	cases := map[string]string{
		"~":            "/home/u",
		"~/.ssh":       "/home/u/.ssh",
		"$HOME/.cache": "/home/u/.cache",
		"/tmp":         "/tmp",
		"":             "",
	}
	for in, want := range cases {
		if got := expandPath(in, home); got != want {
			t.Errorf("expandPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAgentArgv(t *testing.T) {
	cases := []struct {
		agent  AgentType
		resume bool
		prompt string
		want   []string
	}{
		// Codex disables its own sandbox/approvals (it runs inside Hydra's
		// sandbox); the task is a positional argument and resume continues the
		// most recent session in the cwd.
		{AgentTypeCodex, false, "do a thing", []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "do a thing"}},
		{AgentTypeCodex, false, "", []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"}},
		{AgentTypeCodex, true, "ignored on resume", []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "resume", "--last"}},
	}
	for _, c := range cases {
		got, err := AgentArgv(c.agent, c.resume, "system prompt is ignored for codex", c.prompt, "", false, "")
		if err != nil {
			t.Fatalf("AgentArgv(%q, resume=%v) error: %v", c.agent, c.resume, err)
		}
		if strings.Join(got, "\x00") != strings.Join(c.want, "\x00") {
			t.Errorf("AgentArgv(%q, resume=%v, prompt=%q) = %v, want %v", c.agent, c.resume, c.prompt, got, c.want)
		}
	}

	if _, err := AgentArgv(AgentType("nope"), false, "", "", "", false, ""); err == nil {
		t.Error("AgentArgv with unknown agent type: expected error, got nil")
	}
}

// TestAgentArgvChatAndResumeSession covers the chat-mode stream-json argv and
// the explicit --resume <id> resume path (which is what lets a head toggled
// from chat mode back to terminal mode restore its conversation - the TUI's
// --continue can't see -p-recorded sessions).
func TestAgentArgvChatAndResumeSession(t *testing.T) {
	chatFlags := []string{
		"-p", "--input-format", "stream-json", "--output-format", "stream-json",
		"--verbose", "--replay-user-messages", "--include-partial-messages",
		"--permission-prompt-tool", "stdio",
	}
	cases := []struct {
		name      string
		resume    bool
		chatMode  bool
		sessionID string
		want      []string
	}{
		{"chat fresh", false, true, "", append([]string{"claude", "--dangerously-skip-permissions"}, chatFlags...)},
		{"chat resume no id", true, true, "", append(append([]string{"claude", "--dangerously-skip-permissions"}, chatFlags...), "--continue")},
		{"chat resume with id", true, true, "abc-123", append(append([]string{"claude", "--dangerously-skip-permissions"}, chatFlags...), "--resume", "abc-123")},
		{"terminal resume with id", true, false, "abc-123", []string{"claude", "--dangerously-skip-permissions", "--resume", "abc-123"}},
		{"terminal resume no id", true, false, "", []string{"claude", "--dangerously-skip-permissions", "--continue"}},
		// The session id only matters on resume; a fresh spawn ignores it.
		{"fresh ignores id", false, false, "abc-123", []string{"claude", "--dangerously-skip-permissions"}},
	}
	for _, c := range cases {
		got, err := AgentArgv(AgentTypeClaude, c.resume, "", "", "", c.chatMode, c.sessionID)
		if err != nil {
			t.Fatalf("%s: AgentArgv error: %v", c.name, err)
		}
		if strings.Join(got, "\x00") != strings.Join(c.want, "\x00") {
			t.Errorf("%s: AgentArgv = %v, want %v", c.name, got, c.want)
		}
	}

	if _, err := AgentArgv(AgentTypeGemini, false, "", "", "", true, ""); err == nil {
		t.Error("chat mode for gemini: expected error, got nil")
	}
}

func TestAgentArgvCodexChat(t *testing.T) {
	for _, resume := range []bool{false, true} {
		got, err := AgentArgv(AgentTypeCodex, resume, "", "ignored", "ignored", true, "")
		if err != nil {
			t.Fatal(err)
		}
		want := []string{"codex", "--dangerously-bypass-hook-trust", "--enable", "default_mode_request_user_input", "app-server", "--listen", "stdio://"}
		if !slices.Equal(got, want) {
			t.Fatalf("resume=%v: got %q, want %q", resume, got, want)
		}
	}
}

// TestAgentArgvModel verifies --model is passed on a fresh spawn but omitted on
// resume (so the agent restores its transcript's model / any /model change).
func TestAgentArgvModel(t *testing.T) {
	cases := []struct {
		agent  AgentType
		resume bool
		want   []string
	}{
		{AgentTypeClaude, false, []string{"claude", "--dangerously-skip-permissions", "--model", "opus"}},
		{AgentTypeClaude, true, []string{"claude", "--dangerously-skip-permissions", "--continue"}},
		{AgentTypeGemini, false, []string{"gemini", "--approval-mode=yolo", "--model", "opus"}},
		{AgentTypeGemini, true, []string{"gemini", "--approval-mode=yolo", "--resume", "latest"}},
		{AgentTypeCodex, false, []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--model", "opus"}},
		{AgentTypeCodex, true, []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "resume", "--last"}},
	}
	for _, c := range cases {
		got, err := AgentArgv(c.agent, c.resume, "", "", "opus", false, "")
		if err != nil {
			t.Fatalf("AgentArgv(%q, resume=%v) error: %v", c.agent, c.resume, err)
		}
		if strings.Join(got, "\x00") != strings.Join(c.want, "\x00") {
			t.Errorf("AgentArgv(%q, resume=%v, model=opus) = %v, want %v", c.agent, c.resume, got, c.want)
		}
	}
}

func TestExpandAllDedupes(t *testing.T) {
	got := expandAll([]string{"~/.cache", "$HOME/.cache", "", "/tmp"}, "/home/u")
	want := []string{"/home/u/.cache", "/tmp"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("expandAll[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestEnsureWritableDir(t *testing.T) {
	home := t.TempDir()

	// A HOME-anchored path that does not exist yet is created (including parents).
	nested := filepath.Join(home, ".local", "share", "aube")
	ensureWritableDir(nested, home)
	if fi, err := os.Stat(nested); err != nil || !fi.IsDir() {
		t.Errorf("ensureWritableDir did not create HOME-anchored path %q: err=%v", nested, err)
	}

	// An existing path is left untouched (no error, still a dir).
	ensureWritableDir(nested, home)
	if fi, err := os.Stat(nested); err != nil || !fi.IsDir() {
		t.Errorf("ensureWritableDir disturbed existing path %q: err=%v", nested, err)
	}

	// A path OUTSIDE HOME is never created, so a config typo cannot litter the
	// wider filesystem.
	outside := filepath.Join(t.TempDir(), "not-under-home")
	ensureWritableDir(outside, home)
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Errorf("ensureWritableDir created a non-HOME path %q (err=%v); want it left missing", outside, err)
	}

	// Empty inputs are no-ops (must not panic or create anything).
	ensureWritableDir("", home)
	ensureWritableDir(nested, "")
}
