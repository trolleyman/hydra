package config

import (
	"crypto/sha256"
	"encoding/hex"
	"os"

	"braces.dev/errtrace"
)

// ReadProjectConfigTOML returns the raw bytes of the project's .hydra/config.toml
// and whether the file exists. An absent file is (nil, false, nil) — not an error.
// The raw bytes (rather than the parsed config) are what the user reviews and
// trusts, and what the trust hash is computed over.
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

// ConfigHash returns the hex-encoded SHA-256 of the given config content. It is
// used to key project trust to the exact config the user accepted, so any later
// edit (or a branch carrying a different config) re-triggers the trust prompt.
func ConfigHash(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

// ProjectConfigTrusted reports whether the project's current .hydra/config.toml
// is trusted given the hash the user previously accepted (empty if never). A
// project with no config.toml is always trusted — there is nothing
// repo-controlled to execute. Otherwise the current content's hash must match
// the accepted hash.
func ProjectConfigTrusted(projectRoot, trustedHash string) (bool, error) {
	content, exists, err := ReadProjectConfigTOML(projectRoot)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	if !exists {
		return true, nil
	}
	return ConfigHash(content) == trustedHash, nil
}
