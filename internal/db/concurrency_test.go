package db

import (
	"fmt"
	"sync"
	"testing"
)

// TestWALEnabled guards the central premise of the read pool: the read pool can
// only run concurrently with the writer when the file is in WAL mode. The DSN
// previously requested WAL via a shorthand the driver silently ignored, so this
// pins that WAL is actually applied on both pools.
func TestWALEnabled(t *testing.T) {
	store := newTestStore(t)

	var jmWrite, jmRead string
	if err := store.db.Raw("PRAGMA journal_mode").Scan(&jmWrite).Error; err != nil {
		t.Fatalf("writer journal_mode: %v", err)
	}
	if err := store.read.Raw("PRAGMA journal_mode").Scan(&jmRead).Error; err != nil {
		t.Fatalf("reader journal_mode: %v", err)
	}
	if jmWrite != "wal" {
		t.Errorf("writer journal_mode = %q, want wal", jmWrite)
	}
	if jmRead != "wal" {
		t.Errorf("reader journal_mode = %q, want wal", jmRead)
	}

	// The read pool must be query-only so a stray write can't contend for the
	// write lock and reintroduce SQLITE_BUSY.
	var queryOnly int
	if err := store.read.Raw("PRAGMA query_only").Scan(&queryOnly).Error; err != nil {
		t.Fatalf("reader query_only: %v", err)
	}
	if queryOnly != 1 {
		t.Errorf("reader query_only = %d, want 1", queryOnly)
	}
}

// TestConcurrentReadersWithWriter exercises the actual goal: many readers running
// at the same time as a steady stream of writes, with no "database is locked"
// (SQLITE_BUSY) errors. Before the read pool, every read serialised through the
// single writer connection; this would still pass functionally then, but it now
// guards that splitting the pools didn't reintroduce lock contention.
func TestConcurrentReadersWithWriter(t *testing.T) {
	const root = "/tmp/concproj"
	store := newTestStore(t)

	// Seed a handful of agents to read back.
	const nAgents = 8
	for i := 0; i < nAgents; i++ {
		if err := store.UpsertAgent(&Agent{
			ID: fmt.Sprintf("a%d", i), ProjectPath: root, AgentType: "claude",
		}); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	var wg sync.WaitGroup
	errCh := make(chan error, 128)

	// Writer goroutine: a steady stream of status updates.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			id := fmt.Sprintf("a%d", i%nAgents)
			if err := store.UpdateAgentStatus(id, "running", "t", true); err != nil {
				errCh <- fmt.Errorf("write: %w", err)
				return
			}
		}
	}()

	// Many concurrent readers - more than maxReadConns so the pool is saturated.
	for r := 0; r < 16; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				if _, err := store.ListAgents(root); err != nil {
					errCh <- fmt.Errorf("list: %w", err)
					return
				}
				if _, err := store.GetAgent("a0"); err != nil {
					errCh <- fmt.Errorf("get: %w", err)
					return
				}
				if _, err := store.CountUnreadByProject(); err != nil {
					errCh <- fmt.Errorf("count: %w", err)
					return
				}
			}
		}()
	}

	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
}
