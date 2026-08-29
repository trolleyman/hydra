package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"braces.dev/errtrace"
)

// WebProtocol versions the daemon.web ownership record independently from the
// HTTP API. Readers reject unknown formats instead of guessing whether a stale
// listener belongs to a compatible daemon.
const WebProtocol = 1

var ErrStaleWebRecord = errors.New("stale daemon web record")

type WebRecord struct {
	Protocol int    `json:"protocol"`
	URL      string `json:"url"`
	PID      int    `json:"pid"`
}

func webPath(_ string) (string, error) {
	dir, err := ensureRuntimeDir()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return filepath.Join(dir, "daemon.web"), nil
}

// WriteWebURL atomically publishes the HTTP listener belonging to a project's
// live daemon. The Unix control socket remains authoritative for ownership.
func WriteWebURL(projectRoot, webURL string) error {
	parsed, err := url.Parse(webURL)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || !isLoopbackHost(parsed.Hostname()) {
		return errtrace.Errorf("invalid daemon web URL %q", webURL)
	}
	path, err := webPath(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	tmp := path + ".tmp"
	data, err := json.Marshal(WebRecord{Protocol: WebProtocol, URL: webURL, PID: os.Getpid()})
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("encode daemon web URL: %w", err))
	}
	data = append(data, '\n')
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
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
	record, err := ReadWebRecord(projectRoot)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return record.URL, nil
}

// ReadWebRecord returns a compatible listener record only when it names the
// same process as the authoritative daemon pidfile.
func ReadWebRecord(projectRoot string) (*WebRecord, error) {
	path, err := webPath(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var record WebRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("decode daemon web record: %w", err))
	}
	if record.Protocol != WebProtocol {
		return nil, errtrace.Errorf("unsupported daemon web protocol %d", record.Protocol)
	}
	parsed, err := url.Parse(record.URL)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || !isLoopbackHost(parsed.Hostname()) {
		return nil, errtrace.Errorf("daemon web record contains invalid URL %q", record.URL)
	}
	pidFile, err := pidPath(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	pidData, err := os.ReadFile(pidFile)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("read daemon pid for web record: %w", err))
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(pidData)))
	if err != nil || pid <= 0 || record.PID != pid {
		return nil, errtrace.Wrap(fmt.Errorf("%w: pid %d does not match live owner", ErrStaleWebRecord, record.PID))
	}
	return &record, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func removeWebURL(projectRoot string) {
	if path, err := webPath(projectRoot); err == nil {
		_ = os.Remove(path)
		_ = os.Remove(path + ".tmp")
	}
}
