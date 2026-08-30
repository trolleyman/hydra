package db

import (
	"fmt"
	"os"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/glebarez/sqlite"
	"github.com/trolleyman/hydra/internal/paths"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Store wraps the SQLite database and provides typed query methods. It keeps two
// connection pools over the same file: a single-connection writer (SQLite allows
// only one writer at a time) and a multi-connection, query-only read pool. WAL
// mode lets the read pool serve each reader a committed snapshot without blocking
// - or being blocked by - the writer, so the daemon's read-heavy traffic
// (list/get/count from HTTP handlers, the liveness reconciler, the JSON status
// poller, terminal-WS attach) no longer serialises behind every write.
//
// Read methods in queries.go run against `read`; everything that mutates (incl.
// AutoMigrate and the boot backfills) runs against `db`.
type Store struct {
	db   *gorm.DB // writer: a single serialised connection
	read *gorm.DB // readers: a pool of query-only connections
}

// maxReadConns caps the read pool. Reads here are sub-millisecond, so a handful
// of connections is plenty to absorb the daemon's concurrent readers without
// opening more file handles than the workload can ever use at once.
const maxReadConns = 4

// pragmas builds the DSN suffix. The glebarez driver only applies SQLite pragmas
// passed via the `_pragma=name(value)` form - the older `_journal_mode=...` /
// `_foreign_keys=...` shorthands this DSN previously used were parsed but silently
// ignored, so the DB ran in rollback-journal mode (not WAL) with foreign keys
// off. WAL is mandatory here: it's what lets the read pool run concurrently with
// the writer at all.
func pragmas(queryOnly bool) string {
	// synchronous(NORMAL) is the standard pairing for WAL: the WAL is fsynced at
	// checkpoints rather than on every commit. It cannot corrupt the database -
	// WAL replay still recovers a torn commit - the only exposure is losing the
	// last commits to a power cut or kernel panic, which for agent status rows is
	// the right trade. The default (FULL) fsyncs per transaction, and this daemon
	// commits constantly: it was the largest source of fsyncs on the machine, and
	// on ext4 each one forces a journal commit that unrelated writers queue behind.
	p := "?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)"
	if queryOnly {
		// Defence in depth: the read pool must never write (a stray write would
		// contend with the writer for the file lock and reintroduce SQLITE_BUSY).
		p += "&_pragma=query_only(true)"
	}
	return p
}

// Open opens the legacy project-local database used by isolated tests and
// recovery code. Runtime clients use OpenGlobal with the selected state root.
func Open(projectRoot string) (*Store, error) {
	// Move a pre-existing flat .hydra/<dir> layout under .hydra/local first, so the
	// DB (and worktrees etc.) are found at their new home rather than recreated empty.
	if err := paths.MigrateHydraLayout(projectRoot); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("migrate .hydra layout: %w", err))
	}

	stateDir := paths.GetStateDirFromProjectRoot(projectRoot)
	if err := paths.EnsureHydraLocalIgnored(stateDir); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create state dir: %w", err))
	}

	return errtrace.Wrap2(openPath(paths.GetDBPathFromProjectRoot(projectRoot)))
}

// OpenGlobal opens Hydra's user-scoped production database. Project-local
// development databases are deliberately independent and are never imported.
func OpenGlobal(_ string) (*Store, error) {
	dbPath, err := GlobalPath()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create global state directory: %w", err))
	}
	return errtrace.Wrap2(openPath(dbPath))
}

func openPath(dbPath string) (*Store, error) {
	gormCfg := &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)}

	// Writer: a single serialised connection. SQLite permits only one writer at a
	// time, and the daemon shares one *Store across many concurrent goroutines. If
	// the writer pool opened several connections, two of them racing to write - or
	// a writer racing a WAL checkpoint - would block on the busy handler for the
	// full busy_timeout and then fail with "database is locked" (SQLITE_BUSY).
	// Pinning the writer to one connection makes those writes queue cheaply in Go
	// instead of contending for the file lock. Each write is sub-millisecond, so
	// serialising them is far cheaper than the busy-waits it avoids; the pragma's
	// busy_timeout remains the cross-process safety net for the CLI commands
	// (merge/tui) that open the same file in a separate process.
	gormDB, err := gorm.Open(sqlite.Open(dbPath+pragmas(false)), gormCfg)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("open database (writer): %w", err))
	}
	sqlDB, err := gormDB.DB()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("get sql.DB (writer): %w", err))
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	sqlDB.SetConnMaxLifetime(0)

	// Migrate on the writer before opening the read pool, so the schema and the
	// file's WAL mode are established before any reader attaches.
	if err := migrateLegacyReviewColumns(gormDB); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("migrate legacy review columns: %w", err))
	}
	if err := gormDB.AutoMigrate(&Agent{}, &Project{}); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("auto migrate: %w", err))
	}

	// Readers: a small pool of query-only connections. In WAL mode each reader
	// sees the last committed snapshot and runs concurrently with the writer (and
	// with the other readers) without taking the write lock - so reads no longer
	// serialise behind writes the way the old single shared connection forced.
	readDB, err := gorm.Open(sqlite.Open(dbPath+pragmas(true)), gormCfg)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("open database (reader): %w", err))
	}
	readSQL, err := readDB.DB()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("get sql.DB (reader): %w", err))
	}
	readSQL.SetMaxOpenConns(maxReadConns)
	readSQL.SetMaxIdleConns(maxReadConns)
	readSQL.SetConnMaxLifetime(0)

	return &Store{db: gormDB, read: readDB}, nil
}

// migrateLegacyReviewColumns performs the review auto-push column rename that
// AutoMigrate cannot infer. It runs before AutoMigrate so GORM does not create
// empty replacement columns and leave the existing values behind. Each rename
// is independently idempotent, which also makes a partially completed migration
// safe to resume on the next open.
func migrateLegacyReviewColumns(db *gorm.DB) error {
	m := db.Migrator()
	for _, columns := range [][2]string{
		{"publish_when_green", "auto_push"},
		{"publish_when_green_at", "auto_push_at"},
	} {
		oldName, newName := columns[0], columns[1]
		if m.HasColumn(&Agent{}, oldName) && !m.HasColumn(&Agent{}, newName) {
			if err := m.RenameColumn(&Agent{}, oldName, newName); err != nil {
				return errtrace.Wrap(err)
			}
		}
	}
	return nil
}

// Close closes both connection pools. Safe to call on a nil/partially-built
// Store. The long-lived daemon never closes its Store (process exit reclaims the
// handles); this exists for tests and any short-lived CLI use.
func (s *Store) Close() error {
	if s == nil {
		return nil
	}
	var firstErr error
	for _, gdb := range []*gorm.DB{s.read, s.db} {
		if gdb == nil {
			continue
		}
		if sqlDB, err := gdb.DB(); err == nil {
			if cerr := sqlDB.Close(); cerr != nil && firstErr == nil {
				firstErr = cerr
			}
		}
	}
	return errtrace.Wrap(firstErr)
}
