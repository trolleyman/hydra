package heads

import "testing"

func TestStatusTimeAfter(t *testing.T) {
	cases := []struct {
		name string
		a, b string
		want bool
	}{
		{"empty b loses to valid a", "2026-06-15T10:00:00Z", "", true},
		{"invalid a never wins", "", "2026-06-15T10:00:00Z", false},
		{"strictly later", "2026-06-15T10:00:01Z", "2026-06-15T10:00:00Z", true},
		{"equal is not after", "2026-06-15T10:00:00Z", "2026-06-15T10:00:00Z", false},
		// Same wall-clock second, distinguished only by nanoseconds — the case
		// that left agents stuck in "starting".
		{"nano breaks same-second tie", "2026-06-15T10:00:00.200Z", "2026-06-15T10:00:00.100Z", true},
		// Trailing-zero trimming would make ".5" sort after ".50001" lexically;
		// parsing keeps it correct.
		{"trimmed fraction ordered numerically", "2026-06-15T10:00:00.50001Z", "2026-06-15T10:00:00.5Z", true},
	}
	for _, c := range cases {
		if got := statusTimeAfter(c.a, c.b); got != c.want {
			t.Errorf("%s: statusTimeAfter(%q,%q) = %v, want %v", c.name, c.a, c.b, got, c.want)
		}
	}
}
