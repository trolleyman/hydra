package desktop

import "testing"

func TestLaunchConfigDefaultsToInstalledPersistentGlobal(t *testing.T) {
	t.Setenv(LaunchConfigEnv, "")
	got := CurrentLaunchConfig()
	if got.State != "global" || got.BackendLifetime != "persistent" || got.Build != "installed" {
		t.Fatalf("default launch config = %#v", got)
	}
}

func TestLaunchConfigRoundTripsThroughEnvironment(t *testing.T) {
	want := LaunchConfig{State: "checkout", BackendLifetime: "command-owned", Build: "development"}
	if err := SetLaunchConfig(want); err != nil {
		t.Fatal(err)
	}
	if got := CurrentLaunchConfig(); got != want {
		t.Fatalf("launch config = %#v, want %#v", got, want)
	}
}
