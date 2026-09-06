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
	if snap.SessionModel != "" {
		t.Fatalf("top-level session model = %q, want account-wide", snap.SessionModel)
	}
	if snap.WeeklyPercentUsed == nil || *snap.WeeklyPercentUsed != 65 || snap.WeeklyResetText != "1w" || snap.WeeklyResetsAt == nil || !snap.WeeklyResetsAt.Equal(time.Unix(1731552000, 0)) {
		t.Fatalf("secondary snapshot = %+v", snap)
	}
}

func TestParseCodexRateLimitsAcrossNamedLimitGroups(t *testing.T) {
	snap, err := parseCodexRateLimits([]byte(`{
  "rateLimits": {
    "primary": {"usedPercent": 85, "windowDurationMins": 10080, "resetsAt": 1788775171},
    "secondary": null
  },
  "rateLimitsByLimitId": {
    "codex": {
      "primary": {"usedPercent": 85, "windowDurationMins": 10080, "resetsAt": 1788775171},
      "secondary": null
    },
    "codex_bengalfox": {
      "primary": {"usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1788620763},
      "secondary": {"usedPercent": 0, "windowDurationMins": 10080, "resetsAt": 1789207563}
    },
    "base_model_inference": {
      "primary": {"usedPercent": 0, "windowDurationMins": 10080, "resetsAt": 1789207563},
      "secondary": null
    }
  }
}`))
	if err != nil {
		t.Fatal(err)
	}
	if !snap.Available || snap.SessionPercentUsed == nil || *snap.SessionPercentUsed != 0 {
		t.Fatalf("session snapshot = %+v", snap)
	}
	if snap.SessionResetText != "5h" || snap.SessionResetsAt == nil || !snap.SessionResetsAt.Equal(time.Unix(1788620763, 0)) {
		t.Fatalf("session reset = %q %v", snap.SessionResetText, snap.SessionResetsAt)
	}
	if snap.SessionModel != "codex_bengalfox" {
		t.Fatalf("session model = %q, want codex_bengalfox", snap.SessionModel)
	}
	if snap.WeeklyPercentUsed == nil || *snap.WeeklyPercentUsed != 85 || snap.WeeklyResetText != "1w" {
		t.Fatalf("weekly snapshot = %+v", snap)
	}
}

func TestParseCodexRateLimitsFromNamedGroupsOnly(t *testing.T) {
	snap, err := parseCodexRateLimits([]byte(`{
  "rateLimits": {"primary": null},
  "rateLimitsByLimitId": {
    "model": {"primary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1788620763}}
  }
}`))
	if err != nil {
		t.Fatal(err)
	}
	if !snap.Available || snap.SessionPercentUsed == nil || *snap.SessionPercentUsed != 12 || snap.WeeklyPercentUsed != nil {
		t.Fatalf("snapshot = %+v", snap)
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
