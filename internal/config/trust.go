package config

import (
	"os"

	"braces.dev/errtrace"
)

// ReadProjectConfigTOML returns the raw bytes of the project's .hydra/config.toml
// and whether the file exists. An absent file is (nil, false, nil) — not an error.
// The raw bytes (rather than the parsed config) are what the user reviews when
// deciding whether to trust the project.
func ReadProjectConfigTOML(projectRoot string) ([]byte, bool, error) {
	if projectRoot == "" {
		return nil, false, nil
	}
	data, err := os.ReadFile(GetProjectConfigPath(projectRoot))
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, errtrace.Wrap(err)
	}
	return data, true, nil
}

// ProjectConfigTrusted reports whether the project is trusted. Trust is keyed to
// the project path (the user trusts the project once), not to the config
// content — so editing .hydra/config.toml does not re-trigger the trust prompt.
// A project with no config.toml is always trusted: there is nothing
// repo-controlled to execute. Otherwise the project must have been trusted.
func ProjectConfigTrusted(projectRoot string, trusted bool) (bool, error) {
	_, exists, err := ReadProjectConfigTOML(projectRoot)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	if !exists {
		return true, nil
	}
	return trusted, nil
}
