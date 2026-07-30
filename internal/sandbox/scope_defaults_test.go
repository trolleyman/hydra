package sandbox

import "testing"

func TestDefaultCPUQuotasScaleWithHost(t *testing.T) {
	tests := []struct {
		cpus                  int
		workload, machine, bg int
	}{
		{1, 100, 100, 100},
		{2, 100, 100, 100},
		{4, 200, 200, 100},
		{8, 400, 400, 200},
		{16, 400, 800, 400},
		{32, 400, 1600, 400},
		{64, 400, 1600, 400},
	}
	for _, tt := range tests {
		if got := DefaultWorkloadCPUQuota(tt.cpus); got != tt.workload {
			t.Errorf("%d CPUs: workload quota got %d, want %d", tt.cpus, got, tt.workload)
		}
		if got := DefaultMachineCPUQuota(tt.cpus); got != tt.machine {
			t.Errorf("%d CPUs: machine quota got %d, want %d", tt.cpus, got, tt.machine)
		}
		if got := DefaultBackgroundCPUQuota(tt.cpus); got != tt.bg {
			t.Errorf("%d CPUs: background quota got %d, want %d", tt.cpus, got, tt.bg)
		}
	}
}
