package daemon

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
)

func webPath(projectRoot string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, projectKey(projectRoot)+".web"), nil
}

// WriteWebURL atomically publishes the HTTP listener belonging to a project's
// live daemon. The Unix control socket remains authoritative for ownership.
func WriteWebURL(projectRoot, webURL string) error {
	parsed, err := url.Parse(webURL)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" {
		return errtrace.Errorf("invalid daemon web URL %q", webURL)
	}
	path, err := webPath(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(webURL+"\n"), 0o600); err != nil {
		return errtrace.Wrap(fmt.Errorf("write daemon web URL: %w", err))
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return errtrace.Wrap(fmt.Errorf("publish daemon web URL: %w", err))
	}
	return nil
}

// ReadWebURL reads the listener most recently published by a live daemon.
func ReadWebURL(projectRoot string) (string, error) {
	path, err := webPath(projectRoot)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	webURL := strings.TrimSpace(string(data))
	if webURL == "" {
		return "", errtrace.Errorf("daemon web URL is empty")
	}
	return webURL, nil
}

func removeWebURL(projectRoot string) {
	if path, err := webPath(projectRoot); err == nil {
		_ = os.Remove(path)
		_ = os.Remove(path + ".tmp")
	}
}
