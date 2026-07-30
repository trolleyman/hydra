package heads

import (
	"braces.dev/errtrace"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestDeriveTitle(t *testing.T) {
	tests := []struct {
		name   string
		prompt string
		want   string
	}{
		{"empty", "", ""},
		{"whitespace only", "   \n\t  ", ""},
		{"simple", "Fix the login bug", "Fix the login bug"},
		{"first line only", "Refactor auth\nthen test it", "Refactor auth"},
		{"skips blank lines", "\n\n  Add dark mode  ", "Add dark mode"},
		{"strips markdown markers", "## Implement the parser", "Implement the parser"},
		{"strips bullet", "- do the thing", "do the thing"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DeriveTitle(tt.prompt); got != tt.want {
				t.Errorf("DeriveTitle(%q) = %q, want %q", tt.prompt, got, tt.want)
			}
		})
	}
}

func TestDeriveTitleTruncates(t *testing.T) {
	long := strings.Repeat("word ", 40) // ~200 chars
	got := DeriveTitle(long)
	if len([]rune(got)) > maxTitleLen+3 { // +3 for the "..." ellipsis
		t.Errorf("DeriveTitle did not clamp length: got %d runes (%q)", len([]rune(got)), got)
	}
	if !strings.HasSuffix(got, "...") {
		t.Errorf("expected truncated title to end with ellipsis, got %q", got)
	}
}

func TestInlineUploadRefs(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	textPath := write("123-pasted-text-1.txt", "Fix the scaling on the main monitor when it wakes from sleep")
	imgPath := write("456-screenshot.png", "\x89PNG\x00binary")

	t.Run("inlines pasted text", func(t *testing.T) {
		prompt := "Look at this\n\n" + textPath
		got := inlineUploadRefs(prompt, dir)
		want := "Look at this\n\nFix the scaling on the main monitor when it wakes from sleep"
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("reduces image path to filename", func(t *testing.T) {
		got := inlineUploadRefs("See\n\n"+imgPath, dir)
		want := "See\n\n456-screenshot.png"
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("leaves non-upload paths untouched", func(t *testing.T) {
		prompt := "Edit /etc/hosts and src/main.go please"
		if got := inlineUploadRefs(prompt, dir); got != prompt {
			t.Errorf("got %q, want unchanged %q", got, prompt)
		}
	})

	t.Run("missing upload falls back to filename", func(t *testing.T) {
		missing := filepath.Join(dir, "789-gone.txt")
		got := inlineUploadRefs("do it\n\n"+missing, dir)
		want := "do it\n\n789-gone.txt"
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("truncates a large paste", func(t *testing.T) {
		big := write("999-big.txt", strings.Repeat("x", maxInlineUploadBytes*2))
		got := inlineUploadRefs(big, dir)
		if !strings.HasSuffix(got, "\n...") {
			t.Errorf("expected truncation marker, got tail %q", got[len(got)-10:])
		}
		if len(got) > maxInlineUploadBytes+len("\n...") {
			t.Errorf("snippet not bounded: %d bytes", len(got))
		}
	})

	t.Run("empty uploads dir is a no-op", func(t *testing.T) {
		prompt := "hello\n\n" + textPath
		if got := inlineUploadRefs(prompt, ""); got != prompt {
			t.Errorf("got %q, want unchanged", got)
		}
	})
}

func TestSanitizeGeneratedTitle(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want string
	}{
		{"plain", "Fix login bug", "Fix login bug"},
		{"strips quotes", "\"Fix login bug\"", "Fix login bug"},
		{"strips backticks", "`Add dark mode`", "Add dark mode"},
		{"first non-empty line", "\n\nAuth refactor\nignored", "Auth refactor"},
		{"trailing newline", "Title here\n", "Title here"},
		{"empty", "", ""},
		{"whitespace only", "  \n\t\n", ""},
		// Wording is no longer second-guessed: an odd answer is passed through
		// (and clamped) rather than silently dropped. See sanitizeGeneratedTitle.
		{"question is kept", "Which file did you mean?", "Which file did you mean?"},
		{
			"long answer is clamped, not rejected",
			"This task appears to be about fixing the way the main monitor handles scaling on wake",
			"This task appears to be about fixing the way the main...",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeGeneratedTitle(tt.out); got != tt.want {
				t.Errorf("sanitizeGeneratedTitle(%q) = %q, want %q", tt.out, got, tt.want)
			}
		})
	}
}

// TestTitleEnvDisablesThinking guards the fix for the "signal: killed" toast:
// extended thinking left on made haiku spend ~1900 tokens deliberating over a
// 5-word title, which took 20-65s and blew the deadline. The override has to
// come LAST so it wins over a value inherited from the host environment.
func TestTitleEnvDisablesThinking(t *testing.T) {
	t.Setenv("MAX_THINKING_TOKENS", "31999")
	env := titleEnv()

	last := map[string]string{}
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok {
			last[k] = v
		}
	}
	if got := last["MAX_THINKING_TOKENS"]; got != "0" {
		t.Errorf("effective MAX_THINKING_TOKENS = %q, want %q", got, "0")
	}
	if got := last["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]; got != "1" {
		t.Errorf("effective CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = %q, want %q", got, "1")
	}
}

func TestTitleCommandUsesHeadProvider(t *testing.T) {
	instruction := "summarise this"
	tests := []struct {
		name      string
		agentType sandbox.AgentType
		want      []string
	}{
		{
			name:      "claude",
			agentType: sandbox.AgentTypeClaude,
			want:      []string{"claude", "-p", instruction, "--model", "haiku", "--tools", "", "--strict-mcp-config", "--system-prompt", titleSystemPrompt},
		},
		{
			name:      "codex",
			agentType: sandbox.AgentTypeCodex,
			want:      []string{"codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", instruction},
		},
		{
			name:      "gemini",
			agentType: sandbox.AgentTypeGemini,
			want:      []string{"gemini", "--approval-mode", "plan", "--output-format", "text", "-p", instruction},
		},
		{
			name:      "copilot",
			agentType: sandbox.AgentTypeCopilot,
			want:      []string{"copilot", "--autopilot", "-p", instruction},
		},
		{
			name:      "bash falls back to claude",
			agentType: sandbox.AgentTypeBash,
			want:      []string{"claude", "-p", instruction, "--model", "haiku", "--tools", "", "--strict-mcp-config", "--system-prompt", titleSystemPrompt},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := titleCommand(context.Background(), tt.agentType, instruction)
			if got := cmd.Args; !slices.Equal(got, tt.want) {
				t.Errorf("args = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestTitleCallError(t *testing.T) {
	// A killed-on-deadline child reports a bare "signal: killed"; the caller has
	// to learn it was a timeout from the context, not the process error.
	expired, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	err := titleCallError(expired, "claude", errors.New("signal: killed"))
	if !errors.Is(err, ErrTitleTimeout) {
		t.Errorf("expired ctx: got %v, want ErrTitleTimeout", err)
	}
	if strings.Contains(err.Error(), "signal: killed") {
		t.Errorf("timeout error still leaks the opaque signal text: %v", err)
	}

	// A real non-zero exit surfaces the CLI's own first stderr line, which
	// cmd.Output() captures but nothing used to read.
	exit := exitErrorWithStderr(t, "Invalid API key - please run /login\nmore noise\n")
	err = titleCallError(context.Background(), "gemini", exit)
	if !strings.Contains(err.Error(), "Invalid API key") {
		t.Errorf("exit error dropped stderr: %v", err)
	}
	if !strings.Contains(err.Error(), "gemini:") {
		t.Errorf("exit error dropped provider name: %v", err)
	}
	if strings.Contains(err.Error(), "more noise") {
		t.Errorf("exit error should keep only the first stderr line: %v", err)
	}
	if !errors.Is(err, exit) {
		t.Errorf("exit error should wrap the original: %v", err)
	}

	// Nothing on stderr, nothing to add: pass the error through untouched.
	plain := errors.New("exec: \"claude\": executable file not found in $PATH")
	if err := titleCallError(context.Background(), "claude", plain); !errors.Is(err, plain) {
		t.Errorf("plain error should pass through, got %v", err)
	}
}

// exitErrorWithStderr produces a genuine *exec.ExitError carrying stderr, the
// way cmd.Output() does, by running a command that fails after writing to it.
func exitErrorWithStderr(t *testing.T, stderr string) error {
	t.Helper()
	cmd := exec.Command("sh", "-c", "printf '%s' \"$0\" >&2; exit 1", stderr)
	_, err := cmd.Output()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("setup: want *exec.ExitError, got %v", err)
	}
	return errtrace.Wrap(exitErr)
}
