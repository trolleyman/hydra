package db

import (
	"database/sql"
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"time"
)

type Agent struct {
	ID              string
	ProjectID       string
	Name            string
	Prompt          string
	Status          string
	Branch          string
	WorktreePath    string
	SandboxID       *string
	SandboxTemplate *string
	AIProvider      string
	CreatedAt       time.Time
	UpdatedAt       time.Time
	FinishedAt      *time.Time
	LogTail         *string
}

const agentIDChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const agentIDLen = 11

// generateAgentID creates a random 11-character alphanumeric ID.
func generateAgentID() string {
	b := make([]byte, agentIDLen)
	for i := range b {
		b[i] = agentIDChars[rand.Intn(len(agentIDChars))]
	}
	return string(b)
}

// uniqueAgentID generates an ID that doesn't conflict with existing ones.
func uniqueAgentID(db *sql.DB) (string, error) {
	for i := 0; i < 10; i++ {
		id := generateAgentID()
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM agents WHERE id = ?`, id).Scan(&count); err != nil {
			return "", err
		}
		if count == 0 {
			return id, nil
		}
	}
	return "", fmt.Errorf("failed to generate unique agent ID")
}

// uniqueAgentBranch generates a unique branch name within a project.
func uniqueAgentBranch(db *sql.DB, projectID, base string) (string, error) {
	branch := "hydra/" + base
	for i := 2; ; i++ {
		var count int
		err := db.QueryRow(`SELECT COUNT(*) FROM agents WHERE project_id = ? AND branch = ?`, projectID, branch).Scan(&count)
		if err != nil {
			return "", err
		}
		if count == 0 {
			return branch, nil
		}
		branch = fmt.Sprintf("hydra/%s%d", base, i)
	}
}

// promptSlug generates a short URL-safe slug from a prompt string.
func promptSlug(prompt string) string {
	words := strings.Fields(strings.ToLower(prompt))
	if len(words) > 5 {
		words = words[:5]
	}
	slug := nonAlphanumRe.ReplaceAllString(strings.Join(words, "-"), "-")
	slug = strings.Trim(slug, "-")
	if slug == "" {
		slug = "agent"
	}
	if len(slug) > 50 {
		slug = slug[:50]
	}
	return slug
}

// ListAgents returns all agents for a project.
func ListAgents(db *sql.DB, projectID string) ([]Agent, error) {
	rows, err := db.Query(`
		SELECT id, project_id, name, prompt, status, branch, worktree_path,
		       sandbox_id, sandbox_template, ai_provider,
		       created_at, updated_at, finished_at, log_tail
		FROM agents
		WHERE project_id = ?
		ORDER BY created_at DESC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var agents []Agent
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		agents = append(agents, a)
	}
	return agents, rows.Err()
}

// GetAgent returns an agent by project ID + agent ID.
func GetAgent(db *sql.DB, projectID, agentID string) (Agent, error) {
	row := db.QueryRow(`
		SELECT id, project_id, name, prompt, status, branch, worktree_path,
		       sandbox_id, sandbox_template, ai_provider,
		       created_at, updated_at, finished_at, log_tail
		FROM agents
		WHERE project_id = ? AND id = ?`, projectID, agentID)
	a, err := scanAgent(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	return a, err
}

// GetAgentByID returns an agent by ID only (without project scoping).
func GetAgentByID(db *sql.DB, agentID string) (Agent, error) {
	row := db.QueryRow(`
		SELECT id, project_id, name, prompt, status, branch, worktree_path,
		       sandbox_id, sandbox_template, ai_provider,
		       created_at, updated_at, finished_at, log_tail
		FROM agents
		WHERE id = ?`, agentID)
	a, err := scanAgent(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	return a, err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanAgent(s scanner) (Agent, error) {
	var a Agent
	var sandboxID, sandboxTemplate, logTail sql.NullString
	var finishedAt sql.NullTime
	err := s.Scan(
		&a.ID, &a.ProjectID, &a.Name, &a.Prompt, &a.Status,
		&a.Branch, &a.WorktreePath,
		&sandboxID, &sandboxTemplate, &a.AIProvider,
		&a.CreatedAt, &a.UpdatedAt, &finishedAt, &logTail,
	)
	if err != nil {
		return Agent{}, err
	}
	if sandboxID.Valid {
		a.SandboxID = &sandboxID.String
	}
	if sandboxTemplate.Valid {
		a.SandboxTemplate = &sandboxTemplate.String
	}
	if finishedAt.Valid {
		a.FinishedAt = &finishedAt.Time
	}
	if logTail.Valid {
		a.LogTail = &logTail.String
	}
	return a, nil
}

type CreateAgentParams struct {
	ProjectID       string
	Prompt          string
	AIProvider      string
	SandboxTemplate *string
	WorktreesDir    string
}

// CreateAgent inserts a new agent record and returns it.
func CreateAgent(db *sql.DB, params CreateAgentParams) (Agent, error) {
	id, err := uniqueAgentID(db)
	if err != nil {
		return Agent{}, err
	}

	slug := promptSlug(params.Prompt)
	branch, err := uniqueAgentBranch(db, params.ProjectID, slug)
	if err != nil {
		return Agent{}, err
	}

	name := strings.ToUpper(slug[:1]) + slug[1:]
	name = strings.ReplaceAll(name, "-", " ")

	worktreePath := fmt.Sprintf("%s/%s", params.WorktreesDir, branch)

	now := time.Now().UTC()
	_, err = db.Exec(`
		INSERT INTO agents
		    (id, project_id, name, prompt, status, branch, worktree_path,
		     sandbox_template, ai_provider, created_at, updated_at)
		VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
		id, params.ProjectID, name, params.Prompt, branch, worktreePath,
		stringPtrToNull(params.SandboxTemplate), params.AIProvider,
		now, now,
	)
	if err != nil {
		return Agent{}, fmt.Errorf("insert agent: %w", err)
	}

	return Agent{
		ID:              id,
		ProjectID:       params.ProjectID,
		Name:            name,
		Prompt:          params.Prompt,
		Status:          "pending",
		Branch:          branch,
		WorktreePath:    worktreePath,
		SandboxTemplate: params.SandboxTemplate,
		AIProvider:      params.AIProvider,
		CreatedAt:       now,
		UpdatedAt:       now,
	}, nil
}

// UpdateAgentStatus updates the status (and optionally finishedAt) of an agent.
func UpdateAgentStatus(db *sql.DB, agentID, status string) error {
	now := time.Now().UTC()
	var finishedAt sql.NullTime
	if status == "done" || status == "failed" || status == "deleted" {
		finishedAt = sql.NullTime{Time: now, Valid: true}
	}
	_, err := db.Exec(`
		UPDATE agents SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
		status, now, finishedAt, agentID)
	return err
}

// UpdateAgentSandboxID sets the sandbox ID on an agent.
func UpdateAgentSandboxID(db *sql.DB, agentID, sandboxID string) error {
	_, err := db.Exec(`UPDATE agents SET sandbox_id = ?, updated_at = ? WHERE id = ?`,
		sandboxID, time.Now().UTC(), agentID)
	return err
}

// AppendAgentLog appends lines to an agent's log_tail, keeping only the last 10000 chars.
func AppendAgentLog(db *sql.DB, agentID, text string) error {
	const maxLen = 10000
	_, err := db.Exec(`
		UPDATE agents SET
			log_tail = CASE
				WHEN log_tail IS NULL THEN ?
				WHEN LENGTH(log_tail) + LENGTH(?) > ? THEN SUBSTR(log_tail || ?, -?)
				ELSE log_tail || ?
			END,
			updated_at = ?
		WHERE id = ?`,
		text, text, maxLen, text, maxLen, text, time.Now().UTC(), agentID)
	return err
}

// DeleteAgent removes an agent record.
func DeleteAgent(db *sql.DB, projectID, agentID string) error {
	res, err := db.Exec(`DELETE FROM agents WHERE project_id = ? AND id = ?`, projectID, agentID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func stringPtrToNull(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}
