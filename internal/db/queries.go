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

// UpdateContainerInfo updates the container ID and status for an agent.
func (s *Store) UpdateContainerInfo(id, containerID, containerStatus string) error {
	updates := map[string]interface{}{
		"container_status": containerStatus,
	}
	if containerID != "" {
		updates["container_id"] = containerID
	}
	result := s.db.Model(&Agent{}).Where("id = ?", id).Updates(updates)
	return errtrace.Wrap(result.Error)
}

// UpdateAgentStatus updates the agent status and its timestamp.
func (s *Store) UpdateAgentStatus(id, agentStatus, timestamp string) error {
	result := s.db.Model(&Agent{}).Where("id = ?", id).Updates(map[string]interface{}{
		"agent_status":      agentStatus,
		"agent_status_time": timestamp,
	})
	return errtrace.Wrap(result.Error)
}

// SoftDeleteAgent soft-deletes the agent with the given ID.
func (s *Store) SoftDeleteAgent(id string) error {
	result := s.db.Delete(&Agent{}, "id = ?", id)
	return errtrace.Wrap(result.Error)
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
