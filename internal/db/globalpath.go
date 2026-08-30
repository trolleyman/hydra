package db

import (
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/statepath"
)

// GlobalPath returns Hydra's user-scoped database path using the native state
// location for the current platform.
func GlobalPath() (string, error) {
	return errtrace.Wrap2(statepath.DatabasePath())
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
