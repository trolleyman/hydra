package heads

import (
	"log"
	"os"
	"path/filepath"

	"github.com/trolleyman/hydra/internal/paths"
)

func removeSeedInputs(projectRoot, id string) {
	if projectRoot == "" || id == "" {
		return
	}
	removeHeadStateDir("seed inputs", paths.GetSeedDirFromProjectRoot(projectRoot, id), id)
}

func removeProviderState(projectRoot, id string) {
	if projectRoot == "" || id == "" {
		return
	}
	removeHeadStateDir("provider state", paths.GetProviderStateDirFromProjectRoot(projectRoot, id), id)
}

func removeHeadStateDir(what, dir, id string) {
	if err := os.RemoveAll(dir); err != nil {
		log.Printf("warn: heads: remove %s for %s: %v", what, id, err)
		return
	}
	_ = os.Remove(filepath.Dir(dir))
}
