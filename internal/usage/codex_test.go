package usage

import (
	"testing"
	"time"
)

func TestParseCodexRateLimits(t *testing.T) {
	snap, err := parseCodexRateLimits([]byte(`{
  "rateLimits": {
    "primary": {"usedPercent": 38, "windowDurationMins": 300, "resetsAt": 1730947200},
    "secondary": {"usedPercent": 65, "windowDurationMins": 10080, "resetsAt": 1731552000}
  }
}`))
	if err != nil {
		t.Fatal(err)
	}
	if !snap.Available || snap.SessionPercentUsed == nil || *snap.SessionPercentUsed != 38 {
		t.Fatalf("primary snapshot = %+v", snap)
	}
	if snap.SessionResetText != "5h" || snap.SessionResetsAt == nil || !snap.SessionResetsAt.Equal(time.Unix(1730947200, 0)) {
		t.Fatalf("primary reset = %q %v", snap.SessionResetText, snap.SessionResetsAt)
	}
	if snap.WeeklyPercentUsed == nil || *snap.WeeklyPercentUsed != 65 || snap.WeeklyResetText != "1w" {
		t.Fatalf("secondary snapshot = %+v", snap)
	}
}

func TestParseCodexRateLimitsUnavailable(t *testing.T) {
	snap, err := parseCodexRateLimits([]byte(`{"rateLimits": {"primary": null}}`))
	if err != nil {
		t.Fatal(err)
	}
	if snap.Available || !snap.Permanent {
		t.Fatalf("snapshot = %+v, want unavailable permanent result", snap)
	}
}
