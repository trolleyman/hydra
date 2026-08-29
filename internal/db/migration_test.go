package db

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestMigrateLegacyReviewColumnsPreservesValues(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := db.Exec(`CREATE TABLE agents (
		id text PRIMARY KEY,
		publish_when_green numeric NOT NULL DEFAULT 0,
		publish_when_green_at text
	)`).Error; err != nil {
		t.Fatalf("create legacy table: %v", err)
	}
	if err := db.Exec(`INSERT INTO agents (id, publish_when_green, publish_when_green_at)
		VALUES ('h1', 1, '2026-08-29T20:00:00Z')`).Error; err != nil {
		t.Fatalf("insert legacy row: %v", err)
	}

	if err := migrateLegacyReviewColumns(db); err != nil {
		t.Fatalf("migrate columns: %v", err)
	}
	if err := migrateLegacyReviewColumns(db); err != nil {
		t.Fatalf("second migration should be idempotent: %v", err)
	}
	var agent Agent
	if err := db.Unscoped().Select("auto_push", "auto_push_at").First(&agent, "id = ?", "h1").Error; err != nil {
		t.Fatalf("read migrated row: %v", err)
	}
	if !agent.AutoPush || agent.AutoPushAt != "2026-08-29T20:00:00Z" {
		t.Fatalf("migrated auto-push state = (%v, %q), want preserved values", agent.AutoPush, agent.AutoPushAt)
	}
	m := db.Migrator()
	if m.HasColumn(&Agent{}, "publish_when_green") || m.HasColumn(&Agent{}, "publish_when_green_at") {
		t.Fatal("legacy columns still exist after migration")
	}
	if !m.HasColumn(&Agent{}, "auto_push") || !m.HasColumn(&Agent{}, "auto_push_at") {
		t.Fatal("canonical auto-push columns are missing after migration")
	}
}
