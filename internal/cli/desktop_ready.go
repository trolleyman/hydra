package cli

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/desktopcontract"
)

const desktopReadyFileEnv = "HYDRA_DESKTOP_READY_FILE"

type desktopReadyRecord struct {
	Protocol       int    `json:"protocol"`
	URL            string `json:"url"`
	PID            int    `json:"pid"`
	BootstrapToken string `json:"bootstrap_token"`
}

// publishDesktopReady atomically tells a native desktop parent which address
// an OS-assigned listener actually received. It is dormant for ordinary server
// launches. The parent provides a unique, user-private path and watches its
// containing directory, so a partial JSON write must never become visible.
func publishDesktopReady(addr net.Addr, authToken string) (func(), error) {
	path := os.Getenv(desktopReadyFileEnv)
	if path == "" {
		return func() {}, nil
	}
	if addr == nil {
		return nil, errtrace.Wrap(fmt.Errorf("desktop ready: listener has no address"))
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("desktop ready: create directory: %w", err))
	}
	tmp, err := os.CreateTemp(dir, ".hydra-desktop-ready-*")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("desktop ready: create temporary file: %w", err))
	}
	tmpPath := tmp.Name()
	removeTmp := true
	defer func() {
		_ = tmp.Close()
		if removeTmp {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("desktop ready: set permissions: %w", err))
	}
	record := desktopReadyRecord{
		Protocol:       desktopcontract.Protocol,
		URL:            "http://" + addr.String(),
		PID:            os.Getpid(),
		BootstrapToken: authToken,
	}
	if err := json.NewEncoder(tmp).Encode(record); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("desktop ready: encode: %w", err))
	}
	if err := tmp.Sync(); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("desktop ready: sync: %w", err))
	}
	if err := tmp.Close(); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("desktop ready: close: %w", err))
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("desktop ready: publish: %w", err))
	}
	removeTmp = false
	return func() { _ = os.Remove(path) }, nil
}
