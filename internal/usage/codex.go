package usage

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"

	"braces.dev/errtrace"
)

// initializeID / rateLimitsID are the JSON-RPC request ids for the two calls the
// probe makes. The app server requires an `initialize` handshake before it will
// answer anything else - skip it and every method fails with "Not initialized".
const (
	initializeID = 1
	rateLimitsID = 2
	// clientVersion is reported to the app server in the initialize handshake's
	// clientInfo. The server only echoes it back in its user-agent string, so the
	// exact value does not matter.
	clientVersion = "0.1.0"
)

// ProbeCodex asks Codex's app server for the ChatGPT account's current rate
// limit windows. Unlike Claude, Codex exposes this as a JSON-RPC method, so no
// terminal emulation or screen parsing is needed. The app server speaks an
// LSP-style protocol: it must be handed an `initialize` request (answered with
// server info) and an `initialized` notification before any other method is
// accepted, so the probe performs that handshake first.
func ProbeCodex(ctx context.Context, bin, workDir string) (Snapshot, error) {
	if _, err := exec.LookPath(bin); err != nil {
		return Snapshot{CapturedAt: time.Now(), Error: "codex CLI not found in PATH", Permanent: true}, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "app-server", "--listen", "stdio://")
	cmd.Dir = workDir
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}
	if err := cmd.Start(); err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	enc := json.NewEncoder(stdin)
	scanner := bufio.NewScanner(stdout)
	// App-server messages normally fit in a few KB. Keep a generous limit so an
	// unrelated startup notification cannot make a valid response look missing.
	scanner.Buffer(make([]byte, 4096), 1<<20)

	// Handshake: initialize (a request), then the initialized notification.
	if err := enc.Encode(map[string]any{
		"id":     initializeID,
		"method": "initialize",
		"params": map[string]any{
			"clientInfo": map[string]any{"name": "hydra", "version": clientVersion},
		},
	}); err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}
	if _, snap, done, err := readResponse(scanner, initializeID); err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	} else if done {
		return snap, nil // handshake itself failed
	}
	if err := enc.Encode(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}

	// Now the account is initialized, ask for the rate limit windows.
	if err := enc.Encode(map[string]any{"id": rateLimitsID, "method": "account/rateLimits/read", "params": map[string]any{}}); err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}
	result, snap, done, err := readResponse(scanner, rateLimitsID)
	if err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	} else if done {
		return snap, nil
	}
	return errtrace.Wrap2(parseCodexRateLimits(result))
}

// readResponse reads app-server lines until the JSON-RPC response with id wantID
// arrives, skipping notifications and unrelated responses. When that response is
// an error, or the stream ends before it arrives, done is true and the returned
// Snapshot explains why. Otherwise done is false and result carries the
// response's result for the caller to parse.
func readResponse(scanner *bufio.Scanner, wantID int) (result json.RawMessage, snap Snapshot, done bool, err error) {
	for scanner.Scan() {
		var response struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &response); err != nil || response.ID != wantID {
			continue
		}
		if response.Error != nil {
			return nil, Snapshot{CapturedAt: time.Now(), Error: response.Error.Message, Permanent: true}, true, nil
		}
		return response.Result, Snapshot{}, false, nil
	}
	if err := scanner.Err(); err != nil {
		return nil, Snapshot{}, false, errtrace.Wrap(err)
	}
	return nil, Snapshot{CapturedAt: time.Now(), Error: "Codex app server returned no rate limits"}, true, nil
}

func parseCodexRateLimits(raw json.RawMessage) (Snapshot, error) {
	var result struct {
		RateLimits          codexRateLimits            `json:"rateLimits"`
		RateLimitsByLimitID map[string]codexRateLimits `json:"rateLimitsByLimitId"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}

	// Codex puts the account-wide weekly window in rateLimits, while a short
	// window can belong to a specific model in rateLimitsByLimitId. Keep that
	// owner so the UI never presents a Spark-only limit for another model.
	groups := make([]codexLimitGroup, 0, len(result.RateLimitsByLimitID)+1)
	groups = append(groups, codexLimitGroup{limits: result.RateLimits})
	for id, limits := range result.RateLimitsByLimitID {
		groups = append(groups, codexLimitGroup{id: id, limits: limits})
	}
	session, weekly := selectCodexRateLimitWindows(groups)
	if session == nil && weekly == nil {
		return Snapshot{CapturedAt: time.Now(), Error: "Codex account has no subscription rate limits", Permanent: true}, nil
	}

	snap := Snapshot{Available: true, CapturedAt: time.Now()}
	if session != nil {
		snap.SessionPercentUsed = &session.UsedPercent
		snap.SessionResetText = codexWindowLabel(session.WindowDurationMins)
		snap.SessionModel = session.groupID
	}
	if session != nil && session.ResetsAt > 0 {
		t := time.Unix(session.ResetsAt, 0)
		snap.SessionResetsAt = &t
	}
	if weekly != nil {
		snap.WeeklyPercentUsed = &weekly.UsedPercent
		snap.WeeklyResetText = codexWindowLabel(weekly.WindowDurationMins)
		if weekly.ResetsAt > 0 {
			t := time.Unix(weekly.ResetsAt, 0)
			snap.WeeklyResetsAt = &t
		}
	}
	return snap, nil
}

type codexRateLimits struct {
	Primary   *codexRateLimitWindow `json:"primary"`
	Secondary *codexRateLimitWindow `json:"secondary"`
}

type codexLimitGroup struct {
	id     string
	limits codexRateLimits
}

type selectedCodexWindow struct {
	*codexRateLimitWindow
	groupID string
}

type codexRateLimitWindow struct {
	UsedPercent        float64 `json:"usedPercent"`
	WindowDurationMins int     `json:"windowDurationMins"`
	ResetsAt           int64   `json:"resetsAt"`
}

const codexWeekMinutes = 7 * 24 * 60

func selectCodexRateLimitWindows(groups []codexLimitGroup) (session, weekly *selectedCodexWindow) {
	for _, group := range groups {
		for _, window := range []*codexRateLimitWindow{group.limits.Primary, group.limits.Secondary} {
			if window == nil {
				continue
			}
			candidate := &selectedCodexWindow{codexRateLimitWindow: window, groupID: group.id}
			if window.WindowDurationMins < codexWeekMinutes {
				session = preferCodexWindow(session, candidate)
			} else {
				weekly = preferCodexWindow(weekly, candidate)
			}
		}
	}
	return session, weekly
}

// preferCodexWindow keeps the shortest time scale, then the most-used quota
// when several limit groups share that duration. The latter is the useful
// conservative summary for a compact indicator with one value per time scale;
// the later reset makes otherwise-equal choices deterministic and conservative.
func preferCodexWindow(current, candidate *selectedCodexWindow) *selectedCodexWindow {
	if current == nil ||
		(candidate.WindowDurationMins > 0 && (current.WindowDurationMins <= 0 || candidate.WindowDurationMins < current.WindowDurationMins)) ||
		(candidate.WindowDurationMins == current.WindowDurationMins && candidate.UsedPercent > current.UsedPercent) ||
		(candidate.WindowDurationMins == current.WindowDurationMins && candidate.UsedPercent == current.UsedPercent && candidate.ResetsAt > current.ResetsAt) {
		return candidate
	}
	return current
}

func codexWindowLabel(minutes int) string {
	if minutes <= 0 {
		return "limit"
	}
	if minutes%(7*24*60) == 0 {
		return fmt.Sprintf("%dw", minutes/(7*24*60))
	}
	if minutes%60 == 0 {
		return fmt.Sprintf("%dh", minutes/60)
	}
	return fmt.Sprintf("%dm", minutes)
}
