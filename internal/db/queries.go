package db

import (
	"errors"
	"fmt"
	"time"

	"braces.dev/errtrace"
	"gorm.io/gorm"
)

// ErrOperationInProgress is returned when a TrySetHeadStatus CAS fails.
var ErrOperationInProgress = errors.New("operation already in progress")

// UpsertAgent inserts or updates an agent record (restoring soft-deleted records).
func (s *Store) UpsertAgent(a *Agent) error {
	result := s.db.Unscoped().Save(a)
	return errtrace.Wrap(result.Error)
}

// ImportIfAbsent inserts an agent record only when no record with that ID exists.
// Unscoped so it sees soft-deleted rows and does not re-insert them.
func (s *Store) ImportIfAbsent(a *Agent) error {
	var existing Agent
	err := s.db.Unscoped().First(&existing, "id = ?", a.ID).Error
	if err == nil {
		return nil // already present (active or soft-deleted)
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(s.db.Create(a).Error)
}

// GetAgent returns the agent with the given ID, or nil if not found.
func (s *Store) GetAgent(id string) (*Agent, error) {
	var a Agent
	err := s.db.First(&a, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return &a, nil
}

// ListAgents returns all active (non-soft-deleted) agents for the given project.
func (s *Store) ListAgents(projectRoot string) ([]Agent, error) {
	var agents []Agent
	if err := s.db.Where("project_path = ?", projectRoot).Order("created_at DESC").Find(&agents).Error; err != nil {
		return nil, errtrace.Wrap(err)
	}
	return agents, nil
}

// UpdateSessionInfo updates the session PID and status for an agent.
func (s *Store) UpdateSessionInfo(id string, pid int, status string) error {
	updates := map[string]interface{}{
		"session_status": status,
		// gorm's NamingStrategy derives the column for the `SessionPID` struct
		// field as `session_p_id` (it splits the `PID` initialism). Struct-based
		// reads/writes map automatically, but this raw-map write must use the real
		// column name — `session_pid` here silently failed with
		// "no such column: session_pid", breaking the liveness reconciler.
		"session_p_id": pid,
	}
	result := s.db.Model(&Agent{}).Where("id = ?", id).Updates(updates)
	return errtrace.Wrap(result.Error)
}

// UpdateAgentStatus updates the agent status and its timestamp. When markUnread
// is true the has_unread_changes flag is also raised (the caller decides this
// based on the status transition); it is never lowered here — clearing is an
// explicit user action via MarkAgentRead.
func (s *Store) UpdateAgentStatus(id, agentStatus, timestamp string, markUnread bool) error {
	updates := map[string]interface{}{
		"agent_status":      agentStatus,
		"agent_status_time": timestamp,
	}
	if markUnread {
		updates["has_unread_changes"] = true
	}
	result := s.db.Model(&Agent{}).Where("id = ?", id).Updates(updates)
	return errtrace.Wrap(result.Error)
}

// MarkAgentRead clears the has_unread_changes flag for an agent (set when the
// user opens it).
func (s *Store) MarkAgentRead(id string) error {
	result := s.db.Model(&Agent{}).Where("id = ?", id).Update("has_unread_changes", false)
	return errtrace.Wrap(result.Error)
}

// CountUnreadByProject returns, for every project, how many of its active agents
// have unread changes. Projects with no unread agents are omitted. Used to drive
// the cross-project "updates waiting elsewhere" indicator.
func (s *Store) CountUnreadByProject() (map[string]int, error) {
	var rows []struct {
		ProjectPath string
		N           int
	}
	// Exclude ephemeral agents: the sidebar hides them, so they must not inflate
	// the per-project count either.
	err := s.db.Model(&Agent{}).
		Select("project_path, count(*) as n").
		Where("has_unread_changes = ? AND ephemeral = ?", true, false).
		Group("project_path").
		Scan(&rows).Error
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	counts := make(map[string]int, len(rows))
	for _, r := range rows {
		counts[r.ProjectPath] = r.N
	}
	return counts, nil
}

// UpdateAgentTitle updates the user-facing display title for an agent.
func (s *Store) UpdateAgentTitle(id, title string) error {
	result := s.db.Model(&Agent{}).Where("id = ?", id).Update("title", title)
	return errtrace.Wrap(result.Error)
}

// SoftDeleteAgent soft-deletes the agent with the given ID.
func (s *Store) SoftDeleteAgent(id string) error {
	result := s.db.Delete(&Agent{}, "id = ?", id)
	return errtrace.Wrap(result.Error)
}

// ArchiveAgent records how an agent ended (endState: "killed" | "merged") and
// then soft-deletes it, so it leaves the active list but is retained for the
// browsable archived-history list. The end_state write must precede the
// soft-delete (it targets the still-active row).
func (s *Store) ArchiveAgent(id, endState string) error {
	if err := s.db.Model(&Agent{}).Where("id = ?", id).Update("end_state", endState).Error; err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(s.db.Delete(&Agent{}, "id = ?", id).Error)
}

// ListArchivedAgents returns a page of archived (soft-deleted, non-ephemeral,
// with a recorded EndState) agents for the project, newest-archived first. A
// limit <= 0 returns all; offset paginates. Aborted spawns (soft-deleted but
// EndState "") are excluded.
func (s *Store) ListArchivedAgents(projectRoot string, limit, offset int) ([]Agent, error) {
	var agents []Agent
	q := s.db.Unscoped().
		Where("project_path = ? AND deleted_at IS NOT NULL AND end_state <> ? AND ephemeral = ?", projectRoot, "", false).
		Order("deleted_at DESC")
	if limit > 0 {
		q = q.Limit(limit)
	}
	if offset > 0 {
		q = q.Offset(offset)
	}
	if err := q.Find(&agents).Error; err != nil {
		return nil, errtrace.Wrap(err)
	}
	return agents, nil
}

// GetArchivedAgent returns the archived agent with the given ID, or nil if no
// such archived record exists (active agents are not returned here).
func (s *Store) GetArchivedAgent(id string) (*Agent, error) {
	var a Agent
	err := s.db.Unscoped().
		Where("id = ? AND deleted_at IS NOT NULL AND end_state <> ?", id, "").
		First(&a).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return &a, nil
}

// TrySetHeadStatus atomically transitions head_status from `from` to `to`.
// Returns (true, nil) on success, (false, nil) if the row was not in the expected state
// (i.e. someone else already claimed it), or (false, err) on a real error.
func (s *Store) TrySetHeadStatus(id, from, to string) (bool, error) {
	result := s.db.Model(&Agent{}).
		Where("id = ? AND head_status = ?", id, from).
		Update("head_status", to)
	if result.Error != nil {
		return false, errtrace.Wrap(fmt.Errorf("set head status: %w", result.Error))
	}
	return result.RowsAffected > 0, nil
}

// PruneDeletedAgents hard-deletes soft-deleted agent records older than the
// given duration, preventing unbounded table growth over time.
func (s *Store) PruneDeletedAgents(olderThan time.Duration) error {
	cutoff := time.Now().Add(-olderThan)
	result := s.db.Unscoped().Where("deleted_at IS NOT NULL AND deleted_at < ?", cutoff).Delete(&Agent{})
	return errtrace.Wrap(result.Error)
}

// ClearHeadStatus resets head_status to "idle" and optionally records a lastError.
func (s *Store) ClearHeadStatus(id string, lastError *string) error {
	updates := map[string]interface{}{
		"head_status": "idle",
		"last_error":  lastError,
	}
	result := s.db.Model(&Agent{}).Where("id = ?", id).Updates(updates)
	return errtrace.Wrap(result.Error)
}
