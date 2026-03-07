//go:build windows

package db

import (
	"time"

	"gorm.io/gorm"
)

// Agent represents a Hydra agent record in the database.
type Agent struct {
	ID            string `gorm:"primaryKey;not null"`
	ProjectPath   string `gorm:"not null;index;type:text COLLATE NOCASE"`
	ContainerName string // "hydra-agent-<id>" — deterministic

	// Git
	BranchName string
	BaseBranch string

	// Identity
	AgentType string `gorm:"not null"` // "claude" | "gemini"
	PrePrompt string
	Prompt    string
	Ephemeral bool `gorm:"default:false"`

	// Docker — updated by Docker poller
	ContainerID     string
	ContainerStatus string `gorm:"default:pending"` // pending|building|starting|running|stopped

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
