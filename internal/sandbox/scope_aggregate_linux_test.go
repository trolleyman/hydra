//go:build linux

package sandbox

import "testing"

func TestAggregatePropertyOptOutClearsLimits(t *testing.T) {
	if got := quotaProperty(0); got != "CPUQuota=" {
		t.Fatalf("zero quota property = %q, want clear assignment", got)
	}
	got := bandwidthProperties(0, 40)
	if got[0] != "IOReadBandwidthMax=" || got[1] != "IOWriteBandwidthMax=/ 40M" {
		t.Fatalf("bandwidth properties = %q", got)
	}
}
