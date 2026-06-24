package sandbox

import (
	"strings"
	"testing"
)

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
		got, err := AgentArgv(c.agent, c.resume, "system prompt is ignored for codex", c.prompt)
		if err != nil {
			t.Fatalf("AgentArgv(%q, resume=%v) error: %v", c.agent, c.resume, err)
		}
		if strings.Join(got, "\x00") != strings.Join(c.want, "\x00") {
			t.Errorf("AgentArgv(%q, resume=%v, prompt=%q) = %v, want %v", c.agent, c.resume, c.prompt, got, c.want)
		}
	}

	if _, err := AgentArgv(AgentType("nope"), false, "", ""); err == nil {
		t.Error("AgentArgv with unknown agent type: expected error, got nil")
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
