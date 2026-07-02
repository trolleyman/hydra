package sandbox

import (
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
		{AgentTypeCodex, false, "do a thing", []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "do a thing"}},
		{AgentTypeCodex, false, "", []string{"codex", "--dangerously-bypass-approvals-and-sandbox"}},
		{AgentTypeCodex, true, "ignored on resume", []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "resume", "--last"}},
	}
	for _, c := range cases {
		got, err := AgentArgv(c.agent, c.resume, "system prompt is ignored for codex", c.prompt, "")
		if err != nil {
			t.Fatalf("AgentArgv(%q, resume=%v) error: %v", c.agent, c.resume, err)
		}
		if strings.Join(got, "\x00") != strings.Join(c.want, "\x00") {
			t.Errorf("AgentArgv(%q, resume=%v, prompt=%q) = %v, want %v", c.agent, c.resume, c.prompt, got, c.want)
		}
	}

	if _, err := AgentArgv(AgentType("nope"), false, "", "", ""); err == nil {
		t.Error("AgentArgv with unknown agent type: expected error, got nil")
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
		{AgentTypeCodex, false, []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--model", "opus"}},
		{AgentTypeCodex, true, []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "resume", "--last"}},
	}
	for _, c := range cases {
		got, err := AgentArgv(c.agent, c.resume, "", "", "opus")
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
