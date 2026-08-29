package db

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"time"

	"braces.dev/errtrace"
	"github.com/glebarez/sqlite"
	"github.com/trolleyman/hydra/internal/paths"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// LegacyImport records a completed project-local database import. Keeping the
// source file in place makes migration recoverable; this marker makes it
// idempotent on every subsequent daemon boot.
type LegacyImport struct {
	Path       string `gorm:"primaryKey"`
	ImportedAt time.Time
}

// ImportLegacy transactionally imports agents from project-local databases.
// Existing IDs must describe the identical record; a collision with different
// data aborts the complete multi-database import instead of choosing silently.
func (s *Store) ImportLegacy(projectRoots []string) error {
	seen := make(map[string]struct{}, len(projectRoots))
	return errtrace.Wrap(s.db.Transaction(func(tx *gorm.DB) error {
		for _, root := range projectRoots {
			if root == "" {
				continue
			}
			source := paths.GetDBPathFromProjectRoot(root)
			if _, ok := seen[source]; ok {
				continue
			}
			seen[source] = struct{}{}
			if err := importLegacyFile(tx, source); err != nil {
				return errtrace.Wrap(err)
			}
		}
		return nil
	}))
}

func importLegacyFile(target *gorm.DB, source string) error {
	globalPath, err := GlobalPath()
	if err == nil {
		if same, sameErr := samePath(source, globalPath); sameErr == nil && same {
			return nil
		}
	}
	if _, err := os.Stat(source); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return errtrace.Wrap(fmt.Errorf("inspect legacy database %s: %w", source, err))
	}

	var marker LegacyImport
	if err := target.First(&marker, "path = ?", source).Error; err == nil {
		return nil
	} else if err != gorm.ErrRecordNotFound {
		return errtrace.Wrap(err)
	}

	// Open the legacy file in SQLite's read-only mode. Reusing pragmas(true)
	// would still request WAL journal mode before query_only takes effect and
	// could modify the source database merely by inspecting it.
	legacyDSN := source + "?mode=ro&_pragma=query_only(true)&_pragma=busy_timeout(5000)"
	legacy, err := gorm.Open(sqlite.Open(legacyDSN), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("open legacy database %s: %w", source, err))
	}
	legacySQL, err := legacy.DB()
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer legacySQL.Close()

	if !legacy.Migrator().HasTable(&Agent{}) {
		return errtrace.Wrap(target.Create(&LegacyImport{Path: source, ImportedAt: time.Now()}).Error)
	}
	var agents []Agent
	if err := legacy.Unscoped().Find(&agents).Error; err != nil {
		return errtrace.Wrap(fmt.Errorf("read legacy database %s: %w", source, err))
	}

	for i := range agents {
		var existing Agent
		err := target.Unscoped().First(&existing, "id = ?", agents[i].ID).Error
		switch {
		case err == gorm.ErrRecordNotFound:
			if err := target.Unscoped().Create(&agents[i]).Error; err != nil {
				return errtrace.Wrap(err)
			}
		case err != nil:
			return errtrace.Wrap(err)
		case !reflect.DeepEqual(existing, agents[i]):
			return errtrace.Errorf("legacy database %s conflicts on agent ID %s", source, agents[i].ID)
		}
	}
	return errtrace.Wrap(target.Create(&LegacyImport{Path: source, ImportedAt: time.Now()}).Error)
}

func samePath(a, b string) (bool, error) {
	aa, err := filepath.Abs(a)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	bb, err := filepath.Abs(b)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	return paths.ComparePaths(aa, bb), nil
}
