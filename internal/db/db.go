package db

import (
	"fmt"

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

// Open opens (or creates) the SQLite database at <projectRoot>/.hydra/local/state/db.sqlite3,
// enables WAL mode, and runs AutoMigrate to ensure the schema is current.
func Open(projectRoot string) (*Store, error) {
	// Move a pre-existing flat .hydra/<dir> layout under .hydra/local first, so the
	// DB (and worktrees etc.) are found at their new home rather than recreated empty.
	if err := paths.MigrateHydraLayout(projectRoot); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("migrate .hydra layout: %w", err))
	}

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

	// SQLite permits only a single writer at a time. The daemon shares one *Store
	// across many concurrent goroutines (HTTP handlers, the liveness reconciler,
	// the JSON status poller, terminal-WS attach). If database/sql is left to open
	// several pooled connections, two of them racing to write — or a writer racing
	// a WAL checkpoint — block on the busy handler for the full _busy_timeout and
	// then fail with "database is locked" (SQLITE_BUSY). Funnel all in-process
	// access through a single connection so those goroutines queue cheaply in Go
	// instead of contending for the file lock. Every query here is sub-millisecond,
	// so serialization is far cheaper than the 5s busy-waits it replaces; the DSN's
	// _busy_timeout remains the cross-process safety net for the CLI commands
	// (merge/tui) that open the same file in a separate process.
	sqlDB, err := gormDB.DB()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("get sql.DB: %w", err))
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	sqlDB.SetConnMaxLifetime(0)

	if err := gormDB.AutoMigrate(&Agent{}); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("auto migrate: %w", err))
	}

	return &Store{db: gormDB}, nil
}
