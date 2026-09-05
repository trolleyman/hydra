// Package usage probes the locally-installed Claude Code CLI for the account's
// subscription usage quotas and caches the result for a long window.
//
// There is no programmatic API for Claude Code subscription quota: the data is
// only rendered by the interactive `/usage` command. So, like the ClaudeBar
// menu-bar app (https://github.com/tddworks/ClaudeBar), we drive `claude /usage`
// inside a pseudo-terminal, render the TUI through a virtual-terminal emulator,
// and parse the resulting screen text. This is inherently brittle - when
// Anthropic restyles the `/usage` screen the parser may need updating - so the
// parser is covered by tests against captured sample output (usage_test.go), and
// the Cache in front of it is built to give up rather than retry forever when the
// screen stops making sense.
//
// The probe is non-invasive: it auto-responds to trust/onboarding prompts by
// pressing Enter rather than writing trust into the user's ~/.claude.json, and
// it kills the CLI as soon as the quota block is readable.
package usage

import (
	"context"
	"log"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
)

// Snapshot is a parsed point-in-time view of a provider's subscription usage.
// Percentages are "used" (0-100); pointers are nil when the value could not be
// parsed from the `/usage` screen.
type Snapshot struct {
	CapturedAt time.Time
	// Available is true when the probe produced a usable snapshot (at least the
	// session quota). When false, Error explains why (CLI missing, not a
	// subscription account, parse failure, ...).
	Available bool
	Error     string
	// Permanent marks an unavailability that re-probing cannot fix (no CLI on
	// PATH, an account with no subscription quota at all). The Cache parks the
	// probe on one of these instead of retrying on a schedule.
	Permanent bool
	// AccountTier is "Claude Max" / "Claude Pro" when detected, else "".
	AccountTier string

	// Session is the rolling session window (what the user calls the "4 hour"
	// limit). ResetsAt is resolved from the reset line, which the CLI writes
	// either as a countdown ("Resets in 2h 15m") or, more recently, as a wall
	// clock time in the account's timezone ("Resets 3:10pm (Europe/London)").
	SessionPercentUsed *float64
	SessionResetsAt    *time.Time
	SessionResetText   string

	// Weekly is the "Current week (all models)" limit. Its reset is days out and
	// only ever shown as an absolute date, so only the text is captured.
	WeeklyPercentUsed *float64
	WeeklyResetText   string
}

// Complete reports whether both quota bars were read. The probe stops as soon as
// this holds, rather than waiting out its idle timer.
func (s Snapshot) Complete() bool {
	return s.SessionPercentUsed != nil && s.WeeklyPercentUsed != nil
}

// Policy tunes how hard the Cache is willing to work for a snapshot. The probe
// is expensive - it starts a whole Claude CLI under a PTY for a few seconds - so
// the defaults are deliberately lazy: refresh rarely, back off hard on failure,
// and stop entirely once it's clear the probe isn't going to start working.
type Policy struct {
	// TTL is how long a good snapshot is served before a background caller is
	// allowed to re-probe.
	TTL time.Duration
	// MinInterval is the floor between two probes, applied even to forced ones,
	// so a user leaning on the refresh button can't spawn CLIs back to back.
	MinInterval time.Duration
	// FailureBackoff is the wait after the first failure; it doubles with each
	// consecutive failure up to MaxBackoff.
	FailureBackoff time.Duration
	MaxBackoff     time.Duration
	// MaxFailures is how many consecutive failures are tolerated before the probe
	// is parked. Zero or negative means never park.
	MaxFailures int
	// ParkedRetry is the wait a parked probe sits out before one more attempt is
	// allowed. Parking is meant to stop the retrying, not to be permanent: a CLI
	// that gets upgraded, reinstalled or logged back in should start working again
	// on its own, just not by being asked every few minutes.
	ParkedRetry time.Duration
}

// DefaultPolicy is the policy the daemon runs with. The numbers matter more than
// they look: quota percentages move over hours, so a 10-minute TTL is plenty,
// and every value below exists to keep a broken probe from costing anything.
func DefaultPolicy() Policy {
	return Policy{
		TTL:            10 * time.Minute,
		MinInterval:    30 * time.Second,
		FailureBackoff: 2 * time.Minute,
		MaxBackoff:     time.Hour,
		MaxFailures:    5,
		ParkedRetry:    6 * time.Hour,
	}
}

// Cache serves a Snapshot, re-probing at most once per Policy.TTL.
//
// Two properties matter more than freshness. First, Get never blocks on someone
// else's probe: a caller arriving while a probe is in flight is served the
// cached snapshot immediately (several browser tabs polling must not queue up
// behind a multi-second CLI run - that is what made the daemon feel stuck).
// Second, it gives up: repeated failures back off exponentially and then park
// the probe (an attempt every ParkedRetry rather than never again), and a failure
// re-probing is unlikely to fix - no CLI, no subscription - parks it at once.
// Forcing a refresh from the UI skips straight past all of that.
type Cache struct {
	policy Policy
	probe  func(context.Context) (Snapshot, error)

	mu       sync.Mutex
	snap     Snapshot
	at       time.Time
	has      bool
	probing  bool
	lastTry  time.Time
	failures int
	nextTry  time.Time
	parked   bool
	lastErr  string
}

// NewCache returns a Cache that calls probe according to policy. A zero-valued
// field in policy takes its DefaultPolicy value.
func NewCache(policy Policy, probe func(context.Context) (Snapshot, error)) *Cache {
	d := DefaultPolicy()
	if policy.TTL <= 0 {
		policy.TTL = d.TTL
	}
	if policy.MinInterval <= 0 {
		policy.MinInterval = d.MinInterval
	}
	if policy.FailureBackoff <= 0 {
		policy.FailureBackoff = d.FailureBackoff
	}
	if policy.MaxBackoff <= 0 {
		policy.MaxBackoff = d.MaxBackoff
	}
	if policy.ParkedRetry <= 0 {
		policy.ParkedRetry = d.ParkedRetry
	}
	return &Cache{policy: policy, probe: probe}
}

// Get returns the best snapshot it can without waiting on anyone else. It
// re-probes only when the caller is the one allowed to (see shouldProbe); every
// other caller is served what's cached. force is the UI's "refresh now" button:
// it overrides the TTL, the backoff and a parked probe, but not the MinInterval
// floor and not an in-flight probe.
func (c *Cache) Get(ctx context.Context, force bool) (Snapshot, error) {
	c.mu.Lock()
	if !c.shouldProbe(force) {
		snap := c.cached()
		c.mu.Unlock()
		return snap, nil
	}
	c.probing = true
	c.lastTry = time.Now()
	c.mu.Unlock()

	start := time.Now()
	snap, err := c.probe(ctx)
	dur := time.Since(start).Round(time.Millisecond)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.probing = false

	switch {
	case err != nil:
		c.recordFailure(err.Error(), false)
		log.Printf("usage: probe failed after %s (%v); %s", dur, err, c.backoffNote())
		if c.has {
			return c.snap, nil // serve stale rather than erroring
		}
		return c.cached(), errtrace.Wrap(err)
	case !snap.Available:
		// The probe ran but the screen held nothing usable. That is a failure for
		// backoff purposes - retrying a `/usage` screen we can't read is the exact
		// wall this cache exists not to keep hitting.
		c.recordFailure(snap.Error, snap.Permanent)
		log.Printf("usage: probe returned no usable quota after %s (%q); %s", dur, snap.Error, c.backoffNote())
		if c.has {
			return c.snap, nil
		}
		return snap, nil
	default:
		c.snap, c.at, c.has = snap, time.Now(), true
		if c.failures > 0 || c.parked {
			log.Printf("usage: probe recovered after %d failure(s)", c.failures)
		}
		c.failures, c.parked, c.nextTry, c.lastErr = 0, false, time.Time{}, ""
		return snap, nil
	}
}

// shouldProbe decides whether this caller runs the probe. Callers hold c.mu.
func (c *Cache) shouldProbe(force bool) bool {
	now := time.Now()
	switch {
	case c.probing:
		return false // someone else is already doing it; don't queue behind them
	case !c.lastTry.IsZero() && now.Sub(c.lastTry) < c.policy.MinInterval:
		return false // hard floor between CLI launches
	case force:
		return true // the user asked; overrides freshness, backoff and parking
	case c.has && now.Sub(c.at) < c.policy.TTL:
		return false // still fresh
	case !c.nextTry.IsZero() && now.Before(c.nextTry):
		return false // backing off after a failure, or parked (a very long backoff)
	default:
		return true
	}
}

// cached returns what we have to show right now: the last good snapshot if there
// is one, else an unavailable snapshot explaining the current state. Callers hold
// c.mu.
func (c *Cache) cached() Snapshot {
	if c.has {
		return c.snap
	}
	snap := Snapshot{Available: false, Error: c.lastErr}
	if snap.Error == "" {
		snap.Error = "Claude usage has not been probed yet"
	}
	if c.parked {
		snap.Error += " (probe paused)"
		snap.Permanent = true
	}
	return snap
}

// recordFailure advances the backoff, parking the probe once it has failed
// MaxFailures times in a row or hit something re-probing is unlikely to fix.
// Parking is just a much longer backoff (ParkedRetry) - the probe still gets an
// occasional attempt, so a CLI that is reinstalled or logged back in recovers on
// its own, and a manual refresh short-circuits the wait. Callers hold c.mu.
func (c *Cache) recordFailure(msg string, permanent bool) {
	c.failures++
	c.lastErr = msg
	c.parked = permanent || (c.policy.MaxFailures > 0 && c.failures >= c.policy.MaxFailures)

	backoff := c.policy.ParkedRetry
	if !c.parked {
		backoff = c.policy.FailureBackoff << min(c.failures-1, 16)
		if backoff > c.policy.MaxBackoff || backoff <= 0 {
			backoff = c.policy.MaxBackoff
		}
	}
	c.nextTry = time.Now().Add(backoff)
}

// backoffNote describes the post-failure state for the log line. Callers hold c.mu.
func (c *Cache) backoffNote() string {
	wait := time.Until(c.nextTry).Round(time.Second)
	if c.parked {
		return "probe parked after " + strconv.Itoa(c.failures) + " failure(s); next automatic attempt in " + wait.String()
	}
	return "next attempt in " + wait.String()
}

var (
	// percentRe matches "65% left" / "60% used" (case-insensitive).
	percentRe = regexp.MustCompile(`(?i)(\d{1,3})\s*%\s*(left|used)`)
	// resetInRe matches the relative reset form, e.g. "Resets in 2h 15m".
	resetInRe = regexp.MustCompile(`(?i)resets?\s+in\s+([0-9hmsd][0-9hmsd .]*)`)
	// resetAtRe matches the absolute reset form the CLI now uses, with an optional
	// leading date: "Resets 3:10pm (Europe/London)", "Resets Aug 2, 4pm (Europe/London)".
	resetAtRe = regexp.MustCompile(`(?i)resets?\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?`)
	// resetLineRe matches any "Resets ..." line (used for weekly, which is only
	// ever shown as a date and so is carried as text).
	resetLineRe = regexp.MustCompile(`(?i)(resets?\b[^\n]*)`)
	// hoursRe / minsRe / daysRe pick components out of "1d 2h 15m".
	hoursRe = regexp.MustCompile(`(?i)(\d+)\s*h`)
	minsRe  = regexp.MustCompile(`(?i)(\d+)\s*m`)
	daysRe  = regexp.MustCompile(`(?i)(\d+)\s*d`)
)

// sectionMarkers are the headings the `/usage` screen uses. A quota block runs
// from its own heading to the next one, so these are where blockAfter stops -
// without them a section with no percentage would borrow the next section's.
var sectionMarkers = []string{
	"current session",
	"current week",
	"usage credits",
	"what's contributing",
	"subagents",
	"mcp servers",
}

// Parse turns rendered `/usage` screen text into a Snapshot. now is the capture
// time, used to resolve the reset line into an absolute timestamp.
func Parse(text string, now time.Time) Snapshot {
	snap := Snapshot{CapturedAt: now}
	lower := strings.ToLower(text)

	// Pay-as-you-go API accounts don't have subscription quotas; /usage says so.
	// No amount of re-probing will change that, so mark it permanent.
	if strings.Contains(lower, "only available for subscription") {
		snap.Error = "Claude usage is only available on subscription plans"
		snap.Permanent = true
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

	if m := resetLineRe.FindStringSubmatch(sessionBlock); m != nil {
		snap.SessionResetText = strings.TrimSpace(m[1])
	}
	if t, ok := parseResetAt(sessionBlock, now); ok {
		snap.SessionResetsAt = &t
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

// blockAfter returns the line containing label plus the lines under it, stopping
// at the next section heading or after window lines - the slice of screen text
// holding one quota's bar, percentage and reset line.
func blockAfter(text, label string, window int) string {
	lines := strings.Split(text, "\n")
	want := strings.ToLower(label)
	for i, ln := range lines {
		if !strings.Contains(strings.ToLower(ln), want) {
			continue
		}
		out := []string{lines[i]}
		for j := i + 1; j < len(lines) && len(out) <= window; j++ {
			if isSectionHeading(lines[j]) {
				break
			}
			out = append(out, lines[j])
		}
		return strings.Join(out, "\n")
	}
	return ""
}

// isSectionHeading reports whether a line starts a new `/usage` section.
func isSectionHeading(line string) bool {
	lower := strings.ToLower(line)
	for _, m := range sectionMarkers {
		if strings.Contains(lower, m) {
			return true
		}
	}
	return false
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

// parseResetAt resolves a quota block's reset line to an absolute time. The CLI
// writes it two ways and has used both: a countdown ("Resets in 2h 15m") and a
// wall clock time in the account's timezone ("Resets 3:10pm (Europe/London)",
// "Resets Aug 2, 4pm (Europe/London)").
func parseResetAt(block string, now time.Time) (time.Time, bool) {
	if m := resetInRe.FindStringSubmatch(block); m != nil {
		if d, ok := parseRelativeDuration(m[1]); ok {
			return now.Add(d), true
		}
	}

	m := resetAtRe.FindStringSubmatch(block)
	if m == nil {
		return time.Time{}, false
	}
	monthName, dayStr, hourStr, minStr, meridiem, zone := m[1], m[2], m[3], m[4], m[5], m[6]

	hour, err := strconv.Atoi(hourStr)
	if err != nil || hour < 1 || hour > 12 {
		return time.Time{}, false
	}
	hour %= 12 // 12am -> 0, 12pm -> 12 (+12 below)
	if strings.EqualFold(meridiem, "pm") {
		hour += 12
	}
	minute := 0
	if minStr != "" {
		if minute, err = strconv.Atoi(minStr); err != nil || minute > 59 {
			return time.Time{}, false
		}
	}

	loc := time.Local
	if zone != "" {
		if l, lerr := time.LoadLocation(strings.TrimSpace(zone)); lerr == nil {
			loc = l
		}
	}
	local := now.In(loc)

	if monthName != "" && dayStr != "" {
		month, ok := parseMonth(monthName)
		if !ok {
			return time.Time{}, false
		}
		day, derr := strconv.Atoi(dayStr)
		if derr != nil || day < 1 || day > 31 {
			return time.Time{}, false
		}
		t := time.Date(local.Year(), month, day, hour, minute, 0, 0, loc)
		// A reset is always ahead of us; a date that reads as months behind is
		// really next year (a December screen naming a January reset).
		if t.Before(local.Add(-30 * 24 * time.Hour)) {
			t = t.AddDate(1, 0, 0)
		}
		return t, true
	}

	t := time.Date(local.Year(), local.Month(), local.Day(), hour, minute, 0, 0, loc)
	if !t.After(local) {
		t = t.AddDate(0, 0, 1) // already past today, so it's tomorrow's
	}
	return t, true
}

// parseMonth turns a three-letter month abbreviation into a time.Month.
func parseMonth(name string) (time.Month, bool) {
	t, err := time.Parse("Jan", strings.ToTitle(name[:1])+strings.ToLower(name[1:]))
	if err != nil {
		return 0, false
	}
	return t.Month(), true
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
	if m := daysRe.FindStringSubmatch(s); m != nil {
		if days, err := strconv.Atoi(m[1]); err == nil {
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
