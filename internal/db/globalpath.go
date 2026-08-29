package db

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"braces.dev/errtrace"
)

const pathEnvironment = "HYDRA_DB_PATH"

// GlobalPath returns Hydra's user-scoped database path using the native state
// location for the current platform.
func GlobalPath() (string, error) {
	if override := strings.TrimSpace(os.Getenv(pathEnvironment)); override != "" {
		path, err := filepath.Abs(override)
		if err != nil {
			return "", errtrace.Wrap(fmt.Errorf("resolve %s: %w", pathEnvironment, err))
		}
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get home directory: %w", err))
	}
	return errtrace.Wrap2(globalPath(runtime.GOOS, os.Getenv("XDG_STATE_HOME"), os.Getenv("LOCALAPPDATA"), home))
}

func globalPath(goos, xdgStateHome, localAppData, home string) (string, error) {
	switch goos {
	case "linux":
		if xdgStateHome != "" {
			return filepath.Join(xdgStateHome, "hydra", "db.sqlite3"), nil
		}
		return filepath.Join(home, ".local", "state", "hydra", "db.sqlite3"), nil
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Hydra", "db.sqlite3"), nil
	case "windows":
		if localAppData == "" {
			localAppData = strings.TrimRight(home, `\/`) + `\AppData\Local`
		}
		return strings.TrimRight(localAppData, `\/`) + `\Hydra\db.sqlite3`, nil
	default:
		return "", errtrace.Errorf("global database path is unsupported on %s", goos)
	}
}
