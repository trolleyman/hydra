package desktop

import (
	"encoding/json"
	"fmt"
	"os"

	"braces.dev/errtrace"
)

const LaunchConfigEnv = "HYDRA_DESKTOP_LAUNCH_CONFIG"

type LaunchConfig struct {
	State           string `json:"state"`
	BackendLifetime string `json:"backend_lifetime"`
	Build           string `json:"build"`
}

func InstalledLaunchConfig() LaunchConfig {
	return LaunchConfig{State: "global", BackendLifetime: "persistent", Build: "installed"}
}

func SetLaunchConfig(config LaunchConfig) error {
	data, err := json.Marshal(config)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.Setenv(LaunchConfigEnv, string(data)))
}

func CurrentLaunchConfig() LaunchConfig {
	config := InstalledLaunchConfig()
	if raw := os.Getenv(LaunchConfigEnv); raw != "" {
		_ = json.Unmarshal([]byte(raw), &config)
	}
	return config
}

func (config LaunchConfig) String() string {
	return fmt.Sprintf("state=%s backend=%s build=%s", config.State, config.BackendLifetime, config.Build)
}
