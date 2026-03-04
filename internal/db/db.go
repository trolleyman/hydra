package db

import (
	"fmt"
	"os"

	"braces.dev/errtrace"
	"github.com/glebarez/sqlite"
	"github.com/trolleyman/hydra/internal/paths"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Store wraps a *gorm.DB and provides typed query methods.
type Store struct {
	db *gorm.DB
}

// Open opens (or creates) the SQLite database at <projectRoot>/.hydra/state/db.sqlite3,
// enables WAL mode, and runs AutoMigrate to ensure the schema is current.
func Open(projectRoot string) (*Store, error) {
	stateDir := paths.GetStateDirFromProjectRoot(projectRoot)
	if err := paths.CreateGitignoreAllInDir(stateDir); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create state dir: %w", err))
	}

	dbPath := paths.GetDBPathFromProjectRoot(projectRoot)
	dsn := dbPath + "?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on"

	gormDB, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("open database: %w", err))
	}

	if err := gormDB.AutoMigrate(&Agent{}); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("auto migrate: %w", err))
	}

	return &Store{db: gormDB}, nil
}
