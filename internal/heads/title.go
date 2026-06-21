package heads

import (
	"context"
	"log"
	"os/exec"
	"strings"
	"time"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/db"
)

// maxTitleLen bounds both prompt-derived and LLM-generated titles so the
// display name stays short enough for the sidebar and header.
const maxTitleLen = 60

// DeriveTitle produces a short, human-readable title from a prompt's first
// line. It is the immediate, always-available title shown the moment an agent
// spawns, before any (optional, best-effort) LLM refinement lands.
func DeriveTitle(prompt string) string {
	for _, line := range strings.Split(prompt, "\n") {
		line = strings.TrimSpace(line)
		// Skip leading blank lines and markdown-ish bullet/heading markers so the
		// title reads as prose rather than "## " or "- ".
		line = strings.TrimLeft(line, "#-*> \t")
		if line == "" {
			continue
		}
		return truncateTitle(line)
	}
	return ""
}

// truncateTitle clamps a title to maxTitleLen runes, cutting on a word boundary
// where possible and appending an ellipsis when it had to cut.
func truncateTitle(s string) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= maxTitleLen {
		return s
	}
	cut := string(r[:maxTitleLen])
	if i := strings.LastIndex(cut, " "); i > maxTitleLen/2 {
		cut = cut[:i]
	}
	return strings.TrimSpace(cut) + "…"
}

// titleModel is the cheapest Claude tier — title generation is a throwaway
// one-liner where quality barely matters but cost and latency do.
const titleModel = "haiku"

// titleGenTimeout caps how long the one-shot title call may run before we give
// up and keep the prompt-derived title.
const titleGenTimeout = 25 * time.Second

// generateTitleAsync refines an agent's title in the background by asking the
// host `claude` CLI (cheapest model, non-interactive) for a concise summary of
// the prompt, then writing it to the DB for the next poll to pick up. It is
// strictly best-effort: any failure (no credits, offline, CLI missing) leaves
// the prompt-derived title in place. Runs detached from the request lifecycle,
// but bound to ctx (the server-lifetime context) so it — and its `claude` child
// — are cancelled on shutdown rather than left orphaned.
func generateTitleAsync(ctx context.Context, store *db.Store, id, prompt string, onChange func()) {
	if store == nil || strings.TrimSpace(prompt) == "" {
		return
	}
	go func() {
		title, err := generateTitle(ctx, prompt)
		if err != nil {
			// A cancelled context means the server is shutting down, not a real
			// failure — don't cry wolf in the log.
			if ctx.Err() == nil {
				log.Printf("heads: title generation for %s failed (keeping derived title): %v", id, err)
			}
			return
		}
		if title == "" {
			return
		}
		if err := store.UpdateAgentTitle(id, title); err != nil {
			log.Printf("warn: heads: persist generated title for %s: %v", id, err)
			return
		}
		log.Printf("heads: generated title for %s: %q", id, title)
		if onChange != nil {
			onChange()
		}
	}()
}

// generateTitle shells out to `claude -p` for a one-shot title. Kept separate
// from generateTitleAsync so the shell-out is easy to swap for a local model
// later without touching the spawn flow.
func generateTitle(ctx context.Context, prompt string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, titleGenTimeout)
	defer cancel()

	instruction := "Write a concise 3-6 word title summarising this coding task. " +
		"Respond with ONLY the title: no quotes, no trailing punctuation, no preamble.\n\nTask:\n" + prompt

	cmd := exec.CommandContext(ctx, "claude", "-p", instruction, "--model", titleModel)
	out, err := cmd.Output()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return sanitizeGeneratedTitle(string(out)), nil
}

// sanitizeGeneratedTitle reduces raw model output to a single clean title line:
// first non-empty line, surrounding quotes stripped, length-clamped.
func sanitizeGeneratedTitle(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		line = strings.Trim(line, "\"'`")
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		return truncateTitle(line)
	}
	return ""
}
