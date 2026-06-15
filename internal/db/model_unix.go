//go:build !windows

package db

import (
	"time"

	"gorm.io/gorm"
)

// Agent represents a Hydra agent record in the database.
type Agent struct {
	ID          string `gorm:"primaryKey;not null"`
	ProjectPath string `gorm:"not null;index"`

	// Git
	BranchName string
	BaseBranch string

	// Identity
	AgentType string `gorm:"not null"` // "claude" | "gemini"
	PrePrompt string
	Prompt    string
	Ephemeral bool `gorm:"default:false"`

	// Session — updated by the liveness reconciler
	SessionPID    int    // PID of the running sandbox session, 0 if not running
	SessionStatus string `gorm:"default:pending"` // pending|building|starting|running|stopped

	// Agent — updated by JSON poller reading .hydra/status/<id>.json
	AgentStatus     *string // starting|running|waiting|stopped (nil = not yet reported)
	AgentStatusTime string  // RFC3339 of last AgentStatus update

	// Operation — set atomically before long operations
	HeadStatus string  `gorm:"default:idle"` // idle|killing|merging
	LastError  *string // error message from failed operation

	CreatedAt time.Time `gorm:"autoCreateTime:false"` // set explicitly
	UpdatedAt time.Time
	DeletedAt gorm.DeletedAt `gorm:"index"`
}
