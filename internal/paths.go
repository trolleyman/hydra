package internal

import (
	"os"
	"path/filepath"
	"runtime"
)

// DataDir returns the Hydra data directory, creating it if it doesn't exist.
// On Windows: %LOCALAPPDATA%\hydra
// On macOS: ~/Library/Application Support/hydra
// On Linux/other: $XDG_DATA_HOME/hydra (default: ~/.local/share/hydra)
func DataDir() (string, error) {
	dir, err := dataDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return dir, nil
}

func dataDir() (string, error) {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "hydra"), nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", "hydra"), nil
	default:
		// Linux and others: XDG_DATA_HOME
		xdgData := os.Getenv("XDG_DATA_HOME")
		if xdgData != "" {
			return filepath.Join(xdgData, "hydra"), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".local", "share", "hydra"), nil
	}
}

// DBPath returns the path to the SQLite database file.
func DBPath() (string, error) {
	dir, err := DataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "hydra.db"), nil
}

// WorktreesDir returns the directory where agent worktrees are stored.
func WorktreesDir() (string, error) {
	dir, err := DataDir()
	if err != nil {
		return "", err
	}
	wt := filepath.Join(dir, "worktrees")
	if err := os.MkdirAll(wt, 0755); err != nil {
		return "", err
	}
	return wt, nil
}
