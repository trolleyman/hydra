// Package usage probes the locally-installed Claude Code CLI for the account's
// subscription usage quotas and caches the result for a short window.
//
// There is no programmatic API for Claude Code subscription quota: the data is
// only rendered by the interactive `/usage` command. So, like the ClaudeBar
// menu-bar app (https://github.com/tddworks/ClaudeBar), we drive `claude /usage`
// inside a pseudo-terminal, render the TUI through a virtual-terminal emulator,
// and parse the resulting screen text. This is inherently brittle — when
// Anthropic restyles the `/usage` screen the parser may need updating — so the
// parser is covered by tests against captured sample output (usage_test.go).
//
// The probe is non-invasive: it auto-responds to trust/onboarding prompts by
// pressing Enter rather than writing trust into the user's ~/.claude.json, and
// it kills the CLI as soon as the screen settles.
package usage

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Snapshot is a parsed point-in-time view of Claude Code subscription usage.
// Percentages are "used" (0-100); pointers are nil when the value could not be
// parsed from the `/usage` screen.
type Snapshot struct {
	CapturedAt time.Time
	// Available is true when the probe produced a usable snapshot (at least the
	// session quota). When false, Error explains why (CLI missing, not a
	// subscription account, parse failure, …).
	Available bool
	Error     string
	// AccountTier is "Claude Max" / "Claude Pro" when detected, else "".
	AccountTier string

	// Session is the rolling session window (what the user calls the "4 hour"
	// limit). ResetsAt is computed from the "Resets in 2h 15m" relative text.
	SessionPercentUsed *float64
	SessionResetsAt    *time.Time
	SessionResetText   string

	// Weekly is the "Current week (all models)" limit. Its reset is an absolute
	// date in the TUI, so only the text is captured (no countdown requested).
	WeeklyPercentUsed *float64
	WeeklyResetText   string
}

// Cache serves a Snapshot, re-probing at most once per ttl. force bypasses the
// freshness check. Probing is serialized: concurrent callers (e.g. several
// browser tabs polling) coalesce onto one probe and share its result. On probe
// failure a previously-cached snapshot is served stale rather than erroring.
type Cache struct {
	ttl   time.Duration
	probe func(context.Context) (Snapshot, error)

	mu   sync.Mutex
	snap Snapshot
	at   time.Time
	has  bool
}

// NewCache returns a Cache that calls probe to refresh, no more than once per
// ttl unless forced.
func NewCache(ttl time.Duration, probe func(context.Context) (Snapshot, error)) *Cache {
	return &Cache{ttl: ttl, probe: probe}
}

// Get returns the cached snapshot if fresh (and !force), otherwise re-probes.
func (c *Cache) Get(ctx context.Context, force bool) (Snapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !force && c.has && time.Since(c.at) < c.ttl {
		return c.snap, nil
	}

	snap, err := c.probe(ctx)
	if err != nil {
		if c.has {
			return c.snap, nil // serve stale on transient failure
		}
		return Snapshot{}, err
	}
	c.snap, c.at, c.has = snap, time.Now(), true
	return snap, nil
}

var (
	// percentRe matches "65% left" / "60% used" (case-insensitive).
	percentRe = regexp.MustCompile(`(?i)(\d{1,3})\s*%\s*(left|used)`)
	// resetInRe matches the relative session reset, e.g. "Resets in 2h 15m".
	resetInRe = regexp.MustCompile(`(?i)resets?\s+in\s+([0-9hmsd][0-9hmsd .]*)`)
	// resetLineRe matches any "Resets …" line (used for weekly, which is absolute).
	resetLineRe = regexp.MustCompile(`(?i)(resets?\b[^\n]*)`)
	// hoursRe / minsRe pick the hour/minute components out of "2h 15m".
	hoursRe = regexp.MustCompile(`(?i)(\d+)\s*h`)
	minsRe  = regexp.MustCompile(`(?i)(\d+)\s*m`)
)

// Parse turns rendered `/usage` screen text into a Snapshot. now is the capture
// time, used to turn the relative session reset into an absolute timestamp.
func Parse(text string, now time.Time) Snapshot {
	snap := Snapshot{CapturedAt: now}
	lower := strings.ToLower(text)

	// Pay-as-you-go API accounts don't have subscription quotas; /usage says so.
	if strings.Contains(lower, "only available for subscription") {
		snap.Error = "Claude usage is only available on subscription plans"
		return snap
	}

	snap.AccountTier = detectTier(lower)

	sessionBlock := blockAfter(text, "Current session", 3)
	weeklyBlock := blockAfter(text, "Current week (all models)", 3)
	if weeklyBlock == "" {
		weeklyBlock = blockAfter(text, "Current week", 3)
	}

	snap.SessionPercentUsed = percentUsed(sessionBlock)
	snap.WeeklyPercentUsed = percentUsed(weeklyBlock)

	if m := resetInRe.FindStringSubmatch(sessionBlock); m != nil {
		snap.SessionResetText = strings.TrimSpace("Resets in " + m[1])
		if d, ok := parseRelativeDuration(m[1]); ok {
			t := now.Add(d)
			snap.SessionResetsAt = &t
		}
	}
	if m := resetLineRe.FindStringSubmatch(weeklyBlock); m != nil {
		snap.WeeklyResetText = strings.TrimSpace(m[1])
	}

	if snap.SessionPercentUsed != nil {
		snap.Available = true
	} else {
		snap.Error = "could not parse Claude usage output"
	}
	return snap
}

// blockAfter returns the line containing label plus the next `window` lines,
// joined — the slice of screen text holding one quota's bar + percent + reset.
func blockAfter(text, label string, window int) string {
	lines := strings.Split(text, "\n")
	want := strings.ToLower(label)
	for i, ln := range lines {
		if strings.Contains(strings.ToLower(ln), want) {
			end := i + 1 + window
			if end > len(lines) {
				end = len(lines)
			}
			return strings.Join(lines[i:end], "\n")
		}
	}
	return ""
}

// percentUsed extracts a 0-100 "used" percentage from a quota block, converting
// the "% left" form to "% used". Returns nil when no percentage is present.
func percentUsed(block string) *float64 {
	if block == "" {
		return nil
	}
	m := percentRe.FindStringSubmatch(block)
	if m == nil {
		return nil
	}
	v, err := strconv.Atoi(m[1])
	if err != nil {
		return nil
	}
	used := float64(v)
	if strings.EqualFold(m[2], "left") {
		used = 100 - used
	}
	used = min(max(used, 0), 100)
	return &used
}

// parseRelativeDuration parses "2h 15m" / "30m" / "1d 2h" into a Duration.
func parseRelativeDuration(s string) (time.Duration, bool) {
	var d time.Duration
	var any bool
	if m := hoursRe.FindStringSubmatch(s); m != nil {
		if h, err := strconv.Atoi(m[1]); err == nil {
			d += time.Duration(h) * time.Hour
			any = true
		}
	}
	if m := minsRe.FindStringSubmatch(s); m != nil {
		if mins, err := strconv.Atoi(m[1]); err == nil {
			d += time.Duration(mins) * time.Minute
			any = true
		}
	}
	if dm := regexp.MustCompile(`(?i)(\d+)\s*d`).FindStringSubmatch(s); dm != nil {
		if days, err := strconv.Atoi(dm[1]); err == nil {
			d += time.Duration(days) * 24 * time.Hour
			any = true
		}
	}
	return d, any
}

// detectTier classifies the account from the /usage header line, defaulting to
// "Claude Max" when subscription-style quota data is present but the tier label
// isn't (mirrors ClaudeBar's heuristic).
func detectTier(lower string) string {
	switch {
	case strings.Contains(lower, "claude pro"):
		return "Claude Pro"
	case strings.Contains(lower, "claude max"):
		return "Claude Max"
	case strings.Contains(lower, "current session") &&
		(strings.Contains(lower, "% left") || strings.Contains(lower, "% used")):
		return "Claude Max"
	}
	return ""
}
