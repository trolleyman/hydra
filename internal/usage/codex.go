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

// ProbeCodex asks Codex's app server for the ChatGPT account's current rate
// limit windows. Unlike Claude, Codex exposes this as a JSON-RPC method, so no
// terminal emulation or screen parsing is needed.
func ProbeCodex(ctx context.Context, bin, workDir string) (Snapshot, error) {
	if _, err := exec.LookPath(bin); err != nil {
		return Snapshot{CapturedAt: time.Now(), Error: "codex CLI not found in PATH", Permanent: true}, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
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

	if err := json.NewEncoder(stdin).Encode(map[string]any{"id": 1, "method": "account/rateLimits/read", "params": map[string]any{}}); err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}

	var response struct {
		ID     int             `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	scanner := bufio.NewScanner(stdout)
	// App-server messages normally fit in a few KB. Keep a generous limit so an
	// unrelated startup notification cannot make a valid response look missing.
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		if err := json.Unmarshal(scanner.Bytes(), &response); err != nil || response.ID != 1 {
			continue
		}
		if response.Error != nil {
			return Snapshot{CapturedAt: time.Now(), Error: response.Error.Message, Permanent: true}, nil
		}
		return errtrace.Wrap2(parseCodexRateLimits(response.Result))
	}
	if err := scanner.Err(); err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}
	return Snapshot{CapturedAt: time.Now(), Error: "Codex app server returned no rate limits"}, nil
}

func parseCodexRateLimits(raw json.RawMessage) (Snapshot, error) {
	var result struct {
		RateLimits struct {
			Primary   *codexRateLimitWindow `json:"primary"`
			Secondary *codexRateLimitWindow `json:"secondary"`
		} `json:"rateLimits"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return Snapshot{}, errtrace.Wrap(err)
	}
	if result.RateLimits.Primary == nil {
		return Snapshot{CapturedAt: time.Now(), Error: "Codex account has no subscription rate limits", Permanent: true}, nil
	}

	snap := Snapshot{Available: true, CapturedAt: time.Now()}
	snap.SessionPercentUsed = &result.RateLimits.Primary.UsedPercent
	snap.SessionResetText = codexWindowLabel(result.RateLimits.Primary.WindowDurationMins)
	if result.RateLimits.Primary.ResetsAt > 0 {
		t := time.Unix(result.RateLimits.Primary.ResetsAt, 0)
		snap.SessionResetsAt = &t
	}
	if secondary := result.RateLimits.Secondary; secondary != nil {
		snap.WeeklyPercentUsed = &secondary.UsedPercent
		snap.WeeklyResetText = codexWindowLabel(secondary.WindowDurationMins)
	}
	return snap, nil
}

type codexRateLimitWindow struct {
	UsedPercent        float64 `json:"usedPercent"`
	WindowDurationMins int     `json:"windowDurationMins"`
	ResetsAt           int64   `json:"resetsAt"`
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
