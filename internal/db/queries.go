package db

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"braces.dev/errtrace"
	"gorm.io/gorm"
)

// ErrOperationInProgress is returned when a TrySetHeadStatus CAS fails.
var ErrOperationInProgress = errors.New("operation already in progress")

// ErrAgentIDTaken is returned by CreateAgent when a record with the same ID -
// active or archived, in any project - already exists.
var ErrAgentIDTaken = errors.New("agent ID already taken")

// reader returns the query-only read pool used by the read methods below, so
// concurrent reads don't serialise behind the single writer connection. Falls
// back to the writer if a Store was built without a read pool (defensive - Open
// always sets one).
func (s *Store) reader() *gorm.DB {
	if s.read != nil {
		return s.read
	}
	return s.db
}

// UpsertAgent inserts or updates an agent record (restoring soft-deleted records).
func (s *Store) UpsertAgent(a *Agent) error {
	result := s.db.Unscoped().Save(a)
	return errtrace.Wrap(result.Error)
}

// CreateAgent inserts a new agent record, never overwriting an existing one.
// Returns ErrAgentIDTaken when a record with the same ID already exists - the
// ID is a global primary key shared by every project, so this also guards a
// spawn in one project from clobbering a same-ID head in another. The unique
// constraint (not a pre-read) is what detects the clash, so concurrent spawns
// racing on the same ID resolve safely.
func (s *Store) CreateAgent(a *Agent) error {
	err := s.db.Create(a).Error
	if err != nil && (errors.Is(err, gorm.ErrDuplicatedKey) || strings.Contains(err.Error(), "UNIQUE constraint failed")) {
		return errtrace.Wrap(fmt.Errorf("%w: %q", ErrAgentIDTaken, a.ID))
	}
	return errtrace.Wrap(err)
}

// GetAgentAny returns the agent with the given ID regardless of project or
// archival state (soft-deleted rows included), or nil if no such record exists.
// Spawn uses it to detect ID collisions across the whole shared database.
func (s *Store) GetAgentAny(id string) (*Agent, error) {
	var a Agent
	err := s.reader().Unscoped().First(&a, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return &a, nil
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
	err := s.reader().First(&a, "id = ?", id).Error
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
	if err := s.reader().Where("project_path = ?", projectRoot).Order("created_at DESC").Find(&agents).Error; err != nil {
		return nil, errtrace.Wrap(err)
	}
	return agents, nil
}

// AgentsByBaseBranch returns the active (non-soft-deleted) agents in the given
// project whose base branch is baseBranch. Used to reparent stacked agents when
// the branch they sit on is merged away.
func (s *Store) AgentsByBaseBranch(projectRoot, baseBranch string) ([]Agent, error) {
	var agents []Agent
	if err := s.reader().Where("project_path = ? AND base_branch = ?", projectRoot, baseBranch).Find(&agents).Error; err != nil {
		return nil, errtrace.Wrap(err)
	}
	return agents, nil
}

// GetAgentTermSize returns the last terminal geometry recorded for an active
// agent, or (0,0) if none was recorded or the agent is unknown.
func (s *Store) GetAgentTermSize(id string) (rows, cols uint16, err error) {
	var a Agent
	e := s.reader().Select("term_rows", "term_cols").First(&a, "id = ?", id).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return 0, 0, nil
	}
	if e != nil {
		return 0, 0, errtrace.Wrap(e)
	}
	return uint16(a.TermRows), uint16(a.TermCols), nil
}

// SetAgentTermSize records the last terminal geometry a client reported for an
// agent. It writes only the two columns (UpdateColumns skips the UpdatedAt
// bump and hooks), so resizing a terminal never reorders agents in any
// updated_at-sorted view.
func (s *Store) SetAgentTermSize(id string, rows, cols uint16) error {
	result := s.db.Model(&Agent{}).Where("id = ?", id).UpdateColumns(map[string]interface{}{
		"term_rows": rows,
		"term_cols": cols,
	})
	return errtrace.Wrap(result.Error)
}

// LatestTermSizeForProject returns the most recently active agent's terminal
// geometry for a project - the fallback used to seed a head that has no size of
// its own yet. Returns (0,0) if no active agent has a recorded size.
func (s *Store) LatestTermSizeForProject(projectRoot string) (rows, cols uint16, err error) {
	var a Agent
	e := s.reader().Select("term_rows", "term_cols").
		Where("project_path = ? AND term_rows > 0 AND term_cols > 0", projectRoot).
		Order("updated_at DESC").First(&a).Error
	if errors.Is(e, gorm.ErrRecordNotFound) {
		return 0, 0, nil
	}
	if e != nil {
		return 0, 0, errtrace.Wrap(e)
	}
	return uint16(a.TermRows), uint16(a.TermCols), nil
}

// UpdateSessionInfo updates the session PID and status for an agent.
func (s *Store) UpdateSessionInfo(id string, pid int, status string) error {
	updates := map[string]interface{}{
		"session_status": status,
		// gorm's NamingStrategy derives the column for the `SessionPID` struct
		// field as `session_p_id` (it splits the `PID` initialism). Struct-based
		// reads/writes map automatically, but this raw-map write must use the real
		// column name - `session_pid` here silently failed with
		// "no such column: session_pid", breaking the liveness reconciler.
		"session_p_id": pid,
	}
	result := s.db.Model(&Agent{}).Where("id = ?", id).Updates(updates)
	return errtrace.Wrap(result.Error)
}

// UpdateAgentStatus updates the agent status and its timestamp. When markUnread
// is true the has_unread_changes flag is also raised (the caller decides this
// based on the status transition); it is never lowered here - clearing is an
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

// RaiseUnread sets the has_unread_changes flag without touching the status or
// its timestamp. The poller uses this to confirm a deferred running-to-finished
// transition once the agent has held that state past the debounce window -
// separating "raise the flag" from "update the status" that UpdateAgentStatus
// does on the original transition.
func (s *Store) RaiseUnread(id string) error {
	result := s.db.Model(&Agent{}).Where("id = ?", id).Update("has_unread_changes", true)
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
	err := s.reader().Model(&Agent{}).
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

// CountNeedsInputByProject returns, for every project, how many of its active
// agents are currently blocked on the user (status needs_input). Projects with
// no such agents are omitted. Used to drive the cross-project red "needs your
// input" indicator. Unlike unread changes this is keyed off the live status, so
// it clears on its own once the agent is answered rather than on an explicit
// read action.
func (s *Store) CountNeedsInputByProject() (map[string]int, error) {
	var rows []struct {
		ProjectPath string
		N           int
	}
	// Exclude ephemeral agents to match CountUnreadByProject: the sidebar hides
	// them, so they must not inflate the per-project count either.
	err := s.reader().Model(&Agent{}).
		Select("project_path, count(*) as n").
		Where("agent_status = ? AND ephemeral = ?", "needs_input", false).
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

// CountByStatusAndProject returns, for every project, a map of agent_status ->
// count over its active (non-ephemeral, non-archived) agents. Projects with no
// such agents are omitted; a nil/unreported agent_status is bucketed under "".
// Used to drive the project switcher's per-project agent tally (total plus the
// running/waiting/finished/needs_input breakdown). The default gorm scope
// excludes soft-deleted (archived) rows, so this counts only live agents.
func (s *Store) CountByStatusAndProject() (map[string]map[string]int, error) {
	var rows []struct {
		ProjectPath string
		AgentStatus *string
		N           int
	}
	err := s.reader().Model(&Agent{}).
		Select("project_path, agent_status, count(*) as n").
		Where("ephemeral = ?", false).
		Group("project_path, agent_status").
		Scan(&rows).Error
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	counts := make(map[string]map[string]int, len(rows))
	for _, r := range rows {
		byStatus := counts[r.ProjectPath]
		if byStatus == nil {
			byStatus = make(map[string]int)
			counts[r.ProjectPath] = byStatus
		}
		status := ""
		if r.AgentStatus != nil {
			status = *r.AgentStatus
		}
		byStatus[status] += r.N
	}
	return counts, nil
}

// UpdateAgentTitle updates the user-facing display title for an agent.
func (s *Store) UpdateAgentTitle(id, title string) error {
	result := s.db.Model(&Agent{}).Where("id = ?", id).Update("title", title)
	return errtrace.Wrap(result.Error)
}

// UpdateAgentPlan stores the chat plan/to-do JSON for an agent (client-owned,
// opaque). Empty clears it.
func (s *Store) UpdateAgentPlan(id, plan string) error {
	result := s.db.Model(&Agent{}).Where("id = ?", id).Update("plan", plan)
	return errtrace.Wrap(result.Error)
}

// UpdateAgentModel stores the chat head's current model id, captured by the
// daemon from the CLI's system:init line. Empty clears it.
func (s *Store) UpdateAgentModel(id, model string) error {
	result := s.db.Model(&Agent{}).Where("id = ?", id).Update("model", model)
	return errtrace.Wrap(result.Error)
}

// UpdateAgentBaseBranch updates the base branch an agent is considered based on.
// Metadata only: it does not touch the agent's branch, worktree or commits.
func (s *Store) UpdateAgentBaseBranch(id, baseBranch string) error {
	result := s.db.Model(&Agent{}).Where("id = ?", id).Update("base_branch", baseBranch)
	return errtrace.Wrap(result.Error)
}

// UpdateAgentChatMode flips the head's chat-mode flag (Claude only).
// Metadata only; the live session is restarted separately so
// the new mode takes effect.
func (s *Store) UpdateAgentChatMode(id string, chatMode bool) error {
	result := s.db.Model(&Agent{}).Where("id = ?", id).Update("chat_mode", chatMode)
	return errtrace.Wrap(result.Error)
}

// SetDownstreamBranch sets the per-head downstream branch name (the name its work
// is pushed AS; the local branch stays hydra/<id>). Metadata only.
func (s *Store) SetDownstreamBranch(id, branch string) error {
	result := s.db.Model(&Agent{}).Where("id = ?", id).Update("downstream_branch", branch)
	return errtrace.Wrap(result.Error)
}

// SetReviewLink records the head<->MR link after a publish: the forge URL/id, the
// resolved provider, the MR target branch and the downstream branch it was pushed
// as (NON_LOCAL_INTEGRATION.md 3.3 step 4). Metadata only - the head's status
// lifecycle is unchanged.
func (s *Store) SetReviewLink(id, downstreamBranch, url, reviewID, provider, targetBranch string) error {
	updates := map[string]any{
		"downstream_branch":    downstreamBranch,
		"review_url":           url,
		"review_id":            reviewID,
		"review_provider":      provider,
		"review_target_branch": targetBranch,
	}
	result := s.db.Model(&Agent{}).Where("id = ?", id).Updates(updates)
	return errtrace.Wrap(result.Error)
}

// ClearReviewLink detaches a head from its MR (leaves the forge MR alone). Used by
// the "detach" kill/merge option (3.3c). Downstream branch is preserved so a
// re-publish reuses the same name.
func (s *Store) ClearReviewLink(id string) error {
	updates := map[string]any{
		"review_url":           "",
		"review_id":            "",
		"review_provider":      "",
		"review_target_branch": "",
		"review_state":         "",
		"review_state_time":    "",
	}
	result := s.db.Model(&Agent{}).Where("id = ?", id).Updates(updates)
	return errtrace.Wrap(result.Error)
}

// SetReviewState caches the lifecycle watcher's latest MR state JSON (Phase 3) and
// the RFC3339 time it was refreshed.
func (s *Store) SetReviewState(id, state, at string) error {
	updates := map[string]any{"review_state": state, "review_state_time": at}
	result := s.db.Model(&Agent{}).Where("id = ?", id).Updates(updates)
	return errtrace.Wrap(result.Error)
}

// LinkedReviewHeads returns the active heads linked to an MR, across all projects.
// Used by the MR lifecycle watcher (Phase 3) to find candidates to poll.
func (s *Store) LinkedReviewHeads() ([]Agent, error) {
	var agents []Agent
	result := s.reader().Where("review_id <> ? OR review_url <> ?", "", "").Find(&agents)
	return agents, errtrace.Wrap(result.Error)
}

// SetPublishWhenGreen arms or disarms "publish when green" for a head (Phase 3).
func (s *Store) SetPublishWhenGreen(id string, armed bool, armedAt string) error {
	updates := map[string]any{"publish_when_green": armed, "publish_when_green_at": armedAt}
	if !armed {
		updates["publish_when_green_at"] = ""
	}
	result := s.db.Model(&Agent{}).Where("id = ?", id).Updates(updates)
	return errtrace.Wrap(result.Error)
}

// ArmedPublishWhenGreen returns active heads with publish-when-green armed, across
// all projects (Phase 3 watcher).
func (s *Store) ArmedPublishWhenGreen() ([]Agent, error) {
	var agents []Agent
	result := s.reader().Where("publish_when_green = ?", true).Find(&agents)
	return agents, errtrace.Wrap(result.Error)
}

// SetMergeWhenGreen arms or disarms auto-merge for a head (PLAN #68). When
// arming, armedAt records the RFC3339 time; disarming clears it.
func (s *Store) SetMergeWhenGreen(id string, armed bool, armedAt string) error {
	updates := map[string]any{"merge_when_green": armed, "merge_when_green_at": armedAt}
	if !armed {
		updates["merge_when_green_at"] = ""
	}
	result := s.db.Model(&Agent{}).Where("id = ?", id).Updates(updates)
	return errtrace.Wrap(result.Error)
}

// ArmedMergeWhenGreen returns the active heads with auto-merge armed, across all
// projects. Used by the daemon's auto-merge watcher to find candidates when a
// test run settles.
func (s *Store) ArmedMergeWhenGreen() ([]Agent, error) {
	var agents []Agent
	result := s.reader().Where("merge_when_green = ?", true).Find(&agents)
	return agents, errtrace.Wrap(result.Error)
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

// UnarchiveAgent restores a soft-deleted (archived) agent to an active state so
// it can be resumed: it clears deleted_at and end_state and resets the transient
// session/operation fields, while preserving the rest of the record (prompt,
// title, review link, and the last-known AgentStatus the resume nudge reads).
// Select lists the fields by Go name so their zero-value resets are written
// (a plain struct Updates would skip them) and the column names stay in sync.
func (s *Store) UnarchiveAgent(id string) error {
	return errtrace.Wrap(s.db.Unscoped().Model(&Agent{}).Where("id = ?", id).
		Select("DeletedAt", "EndState", "SessionStatus", "SessionPID", "HeadStatus", "LastError").
		Updates(&Agent{SessionStatus: "pending", HeadStatus: "idle"}).Error)
}

// ListArchivedAgents returns a page of archived (soft-deleted, non-ephemeral,
// with a recorded EndState) agents for the project, newest-created first - i.e.
// ordered by the same creation timestamp the UI shows for each agent, matching
// the active list's ordering. A limit <= 0 returns all; offset paginates.
// Aborted spawns (soft-deleted but EndState "") are excluded.
func (s *Store) ListArchivedAgents(projectRoot string, limit, offset int) ([]Agent, error) {
	var agents []Agent
	q := s.reader().Unscoped().
		Where("project_path = ? AND deleted_at IS NOT NULL AND end_state <> ? AND ephemeral = ?", projectRoot, "", false).
		Order("created_at DESC")
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
	err := s.reader().Unscoped().
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

// BackfillArchivedEndState retroactively marks pre-existing soft-deleted agents
// as archived ("killed") so they surface in the browsable archived-history list.
//
// Before the EndState column existed, killing/merging a head simply soft-deleted
// it with an empty EndState - in storage indistinguishable from an aborted spawn
// (which is also soft-deleted with EndState ""). We upgrade only rows that show
// evidence of having actually run: a session that reached a non-"pending" status
// (UpdateSessionInfo flips it to "running" only after the sandbox session
// starts), or a reported agent status. Genuinely aborted spawns fail before the
// session starts - they stay session_status "pending" with a nil agent_status -
// so they remain excluded.
//
// endState is always "killed": the original kill/merge distinction was never
// recorded, so it can't be reconstructed; "killed" is the safe, common default.
// Idempotent - it only touches non-ephemeral soft-deleted rows whose EndState is
// still empty, so it's a no-op on every boot after the first. Returns the number
// of rows upgraded.
func (s *Store) BackfillArchivedEndState() (int64, error) {
	result := s.db.Unscoped().
		Model(&Agent{}).
		Where("deleted_at IS NOT NULL AND ephemeral = ? AND (end_state IS NULL OR end_state = ?)", false, "").
		Where("(session_status IS NOT NULL AND session_status <> '' AND session_status <> ?) OR (agent_status IS NOT NULL AND agent_status <> ?)", "pending", "").
		Update("end_state", "killed")
	return result.RowsAffected, errtrace.Wrap(result.Error)
}

// SetArchivedEndStateMerged corrects archived heads that were actually merged but
// recorded as "killed". The pre-EndState backfill defaulted every archived head
// to "killed", and CLI merges historically archived through the kill path, so a
// merged head can end up mislabelled. git.MergedHydraBranches recovers the truth
// from merge commits; this flips the matching rows (soft-deleted, non-ephemeral,
// in the given project, branch in branchNames) to "merged".
//
// It only ever UPGRADES a non-empty, non-"merged" end_state - it never downgrades
// or touches active rows or aborted spawns (empty end_state). That one-way rule
// keeps fast-forward merges (which git.MergedHydraBranches can't detect, so they
// stay "killed") from being wrongly flipped back and forth. Returns rows changed.
func (s *Store) SetArchivedEndStateMerged(projectRoot string, branchNames []string) (int64, error) {
	if len(branchNames) == 0 {
		return 0, nil
	}
	result := s.db.Unscoped().
		Model(&Agent{}).
		Where("project_path = ? AND deleted_at IS NOT NULL AND ephemeral = ?", projectRoot, false).
		Where("end_state <> ? AND end_state <> ?", "", "merged").
		Where("branch_name IN ?", branchNames).
		Update("end_state", "merged")
	return result.RowsAffected, errtrace.Wrap(result.Error)
}

// HardDeleteAgent permanently and irreversibly removes an agent row - active or
// already soft-deleted (archived) - from the database, leaving no trace in the
// archived-history list. Used only by the "delete for real" purge path; normal
// kill/merge archival uses ArchiveAgent (a soft delete) instead.
func (s *Store) HardDeleteAgent(id string) error {
	return errtrace.Wrap(s.db.Unscoped().Delete(&Agent{}, "id = ?", id).Error)
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
