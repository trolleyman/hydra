package docker

import (
	"braces.dev/errtrace"
	"encoding/json"
	"fmt"
	"net/url"
	"time"
)

// LabelKey is the Docker label used to identify Hydra-managed containers.
const LabelKey = "org.trolleyman.hydra"

// AgentMetadata is the structured data stored in the Hydra Docker label.
type AgentMetadata struct {
	Prompt           string    `json:"prompt"`
	HostWorktreePath string    `json:"host_worktree_path"`
	CreatedAt        time.Time `json:"created_at"`
	BranchName       string    `json:"branch_name"`
	BaseBranch       string    `json:"base_branch"`
}

// EncodeLabel serialises metadata to a URL-encoded JSON string for use as a Docker label value.
func EncodeLabel(meta *AgentMetadata) (string, error) {
	data, err := json.Marshal(meta)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("marshal label: %w", err))
	}
	return url.QueryEscape(string(data)), nil
}

// DecodeLabel deserialises a label value back into AgentMetadata.
func DecodeLabel(value string) (*AgentMetadata, error) {
	decoded, err := url.QueryUnescape(value)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("unescape label: %w", err))
	}
	var meta AgentMetadata
	if err := json.Unmarshal([]byte(decoded), &meta); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("unmarshal label: %w", err))
	}
	return &meta, nil
}
