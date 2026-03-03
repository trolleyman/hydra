package heads

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"time"

	dockerclient "github.com/docker/docker/client"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/paths"
)

// RunDockerPoller runs a polling loop that syncs Docker container state into the DB every 5 seconds.
func RunDockerPoller(ctx context.Context, cli *dockerclient.Client, store *db.Store, projectRoot string) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			RunDockerPollerOnce(ctx, cli, store, projectRoot)
		}
	}
}

// RunDockerPollerOnce performs a single Docker polling cycle.
func RunDockerPollerOnce(ctx context.Context, cli *dockerclient.Client, store *db.Store, projectRoot string) {
	pollDockerOnce(ctx, cli, store, projectRoot)
}

func pollDockerOnce(ctx context.Context, cli *dockerclient.Client, store *db.Store, projectRoot string) {
	// Get all running Docker containers.
	dockerAgents, err := docker.ListAgents(ctx, cli)
	if err != nil {
		log.Printf("warn: docker poller: list agents: %v", err)
		return
	}
	dockerByID := make(map[string]docker.Agent, len(dockerAgents))
	for _, a := range dockerAgents {
		dockerByID[a.Meta.Id] = a
	}

	// Get all active DB agents for this project.
	dbAgents, err := store.ListAgents(projectRoot)
	if err != nil {
		log.Printf("warn: docker poller: list db agents: %v", err)
		return
	}
	dbByID := make(map[string]struct{}, len(dbAgents))
	for _, a := range dbAgents {
		dbByID[a.ID] = struct{}{}
		da, inDocker := dockerByID[a.ID]
		if inDocker {
			// Determine DB container status from the machine-readable Docker state.
			var containerStatus string
			switch da.State {
			case "running":
				containerStatus = "running"
			default:
				containerStatus = "stopped"
			}
			if err := store.UpdateContainerInfo(a.ID, da.ContainerID, containerStatus); err != nil {
				log.Printf("warn: docker poller: update container info for %s: %v", a.ID, err)
			}
		} else if a.ContainerID != "" {
			// Container was known but is now gone.
			if err := store.UpdateContainerInfo(a.ID, a.ContainerID, "stopped"); err != nil {
				log.Printf("warn: docker poller: mark stopped %s: %v", a.ID, err)
			}
		}
		// Containers with empty ContainerID and not in Docker remain in "pending" or "building".
	}

	// Import legacy containers that are in Docker but not in DB.
	for _, da := range dockerAgents {
		if _, inDB := dbByID[da.Meta.Id]; inDB {
			continue
		}
		containerStatus := "stopped"
		if da.State == "running" {
			containerStatus = "running"
		}
		containerName := "hydra-agent-" + da.Meta.Id
		agent := &db.Agent{
			ID:              da.Meta.Id,
			ProjectPath:     da.Meta.ProjectPath,
			ContainerName:   containerName,
			BranchName:      da.Meta.BranchName,
			BaseBranch:      da.Meta.BaseBranch,
			AgentType:       string(da.Meta.AgentType),
			PrePrompt:       da.Meta.PrePrompt,
			Prompt:          da.Meta.Prompt,
			ContainerID:     da.ContainerID,
			ContainerStatus: containerStatus,
			HeadStatus:      "idle",
			CreatedAt:       time.Unix(da.Created, 0),
		}
		if err := store.ImportIfAbsent(agent); err != nil {
			log.Printf("warn: docker poller: import legacy container %s: %v", da.Meta.Id, err)
		}
	}
}

// RunJSONStatusPoller runs a polling loop that syncs JSON status files into the DB every 1 second.
func RunJSONStatusPoller(ctx context.Context, store *db.Store, projectRoot string) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			RunJSONStatusPollerOnce(store, projectRoot)
		}
	}
}

// RunJSONStatusPollerOnce performs a single JSON status polling cycle.
func RunJSONStatusPollerOnce(store *db.Store, projectRoot string) {
	pollJSONStatusOnce(store, projectRoot)
}

func pollJSONStatusOnce(store *db.Store, projectRoot string) {
	agents, err := store.ListAgents(projectRoot)
	if err != nil {
		log.Printf("warn: json status poller: list agents: %v", err)
		return
	}

	for _, a := range agents {
		if a.ContainerStatus != "running" {
			continue
		}
		info := readStatusJSON(projectRoot, a.ID)
		if info == nil || info.Timestamp == "" {
			continue
		}
		// Only update if the timestamp in the file is newer than what we have in the DB.
		if info.Timestamp <= a.AgentStatusTime {
			continue
		}
		agentStatus := mapAgentStatus(info.Status)
		if agentStatus == "" {
			continue
		}
		if err := store.UpdateAgentStatus(a.ID, agentStatus, info.Timestamp); err != nil {
			log.Printf("warn: json status poller: update agent status for %s: %v", a.ID, err)
		}
	}
}

func readStatusJSON(projectRoot, id string) *api.AgentStatusInfo {
	path := paths.GetStatusJsonFromProjectRoot(projectRoot, id)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var s api.AgentStatusInfo
	if err := json.Unmarshal(data, &s); err != nil {
		return nil
	}
	return &s
}

// mapAgentStatus maps an api.AgentStatus value to the DB agent_status string.
// Handles both current and legacy status values written by trigger-hook.
func mapAgentStatus(s api.AgentStatus) string {
	switch s {
	case api.Starting:
		return "starting"
	case api.Running:
		return "running"
	case api.Waiting:
		return "waiting"
	case api.Stopped, "ended", "exited":
		return "stopped"
	default:
		return ""
	}
}
