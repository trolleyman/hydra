package docker

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"

	"braces.dev/errtrace"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	dockerclient "github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"github.com/trolleyman/hydra/internal/config"
)

// Agent represents a running or stopped Hydra-managed container.
type Agent struct {
	ContainerID   string
	ContainerName string
	Status        string
	ImageName     string
	Meta          *AgentMetadata
}

// NewClient creates a Docker client from the environment (DOCKER_HOST, etc.).
func NewClient() (*dockerclient.Client, error) {
	cli, err := dockerclient.NewClientWithOpts(
		dockerclient.FromEnv,
		dockerclient.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create docker client: %w", err))
	}
	return cli, nil
}

// ListAgents returns all containers carrying the Hydra label.
func ListAgents(ctx context.Context, cli *dockerclient.Client) ([]Agent, error) {
	args := filters.NewArgs(filters.Arg("label", LabelKey))
	containers, err := cli.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: args,
	})
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("list containers: %w", err))
	}

	var agents []Agent
	for _, c := range containers {
		labelVal, ok := c.Labels[LabelKey]
		if !ok {
			continue
		}
		meta, err := DecodeLabel(labelVal)
		if err != nil {
			log.Printf("warn: decode label for %s: %v", c.ID[:12], err)
			continue
		}
		name := ""
		if len(c.Names) > 0 {
			name = c.Names[0]
		}
		agents = append(agents, Agent{
			ContainerID:   c.ID,
			ContainerName: name,
			Status:        c.Status,
			ImageName:     c.Image,
			Meta:          meta,
		})
	}
	return agents, nil
}

// SpawnOptions holds all configuration for launching a new agent container.
type SpawnOptions struct {
	Id             string
	AgentType      AgentType
	Prompt         string
	ProjectPath    string
	WorktreePath   string
	BranchName     string
	BaseBranch     string
	GitAuthorName  string
	GitAuthorEmail string
	UID            int
	GID            int
	Username       string
	GroupName      string
}

// SpawnAgent builds the Docker image if necessary, then creates and starts the container.
// Returns the container ID.
func SpawnAgent(ctx context.Context, cli *dockerclient.Client, opts SpawnOptions) (string, error) {
	dockerfileContent, err := dockerfileForAgent(opts.AgentType)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	imageTag, err := ensureImage(ctx, cli, opts.AgentType, dockerfileContent)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("ensure image: %w", err))
	}

	meta := &AgentMetadata{
		Id:               opts.Id,
		AgentType:        opts.AgentType,
		Prompt:           opts.Prompt,
		ProjectPath:      opts.ProjectPath,
		HostWorktreePath: opts.WorktreePath,
		BranchName:       opts.BranchName,
		BaseBranch:       opts.BaseBranch,
	}
	labelVal, err := EncodeLabel(meta)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("encode label: %w", err))
	}

	// The entrypoint script creates a user in the container matching the host user's UID/GID/name,
	// then exec's into the agent as that user. This ensures file permissions round-trip correctly.
	containerHome := "/home/" + opts.Username
	env := []string{
		fmt.Sprintf("AGENT_UID=%d", opts.UID),
		fmt.Sprintf("AGENT_GID=%d", opts.GID),
		"AGENT_USER=" + opts.Username,
		"AGENT_GROUP=" + opts.GroupName,
		"AGENT_HOME=" + containerHome,
	}
	if opts.GitAuthorName != "" {
		env = append(env,
			"GIT_AUTHOR_NAME="+opts.GitAuthorName,
			"GIT_COMMITTER_NAME="+opts.GitAuthorName,
		)
	}
	if opts.GitAuthorEmail != "" {
		env = append(env,
			"GIT_AUTHOR_EMAIL="+opts.GitAuthorEmail,
			"GIT_COMMITTER_EMAIL="+opts.GitAuthorEmail,
		)
	}

	// Mount the main .git directory and the worktree at the same absolute paths as on the host.
	// This is required because git worktree .git files contain absolute paths back to the main .git dir.
	gitDir := opts.ProjectPath + "/.git"
	binds := []string{
		gitDir + ":" + gitDir + ":rw",
		opts.WorktreePath + ":" + opts.WorktreePath + ":rw",
	}
	binds = append(binds, agentBinds(opts.AgentType, containerHome)...)

	var netCfg *network.NetworkingConfig
	var platform *ocispec.Platform

	containerName := "hydra-" + opts.Id
	log.Printf("Creating container %s for agent %s...", containerName, opts.Id)
	resp, err := cli.ContainerCreate(ctx,
		&container.Config{
			Image:      imageTag,
			Cmd:        []string{opts.Prompt},
			Labels:     map[string]string{LabelKey: labelVal},
			Tty:        true,
			Env:        env,
			WorkingDir: opts.WorktreePath,
		},
		&container.HostConfig{
			Binds: binds,
		},
		netCfg,
		platform,
		containerName,
	)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create container: %w", err))
	}

	if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		_ = cli.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
		return "", errtrace.Wrap(fmt.Errorf("start container: %w", err))
	}

	return resp.ID, nil
}

// KillAgent stops and removes a container.
func KillAgent(ctx context.Context, cli *dockerclient.Client, containerID string) error {
	timeout := 10
	if err := cli.ContainerStop(ctx, containerID, container.StopOptions{Timeout: &timeout}); err != nil {
		log.Printf("warn: stop container %s: %v", containerID[:12], err)
	}
	if err := cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true}); err != nil {
		return errtrace.Wrap(fmt.Errorf("remove container: %w", err))
	}
	return nil
}

// AttachAgent runs `docker attach <id>`, handing over the terminal.
func AttachAgent(containerID string) error {
	cmd := exec.Command("docker", "attach", containerID)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return errtrace.Wrap(cmd.Run())
}

// ViewLogs runs `docker logs -f <id>`, streaming output to the terminal.
func ViewLogs(containerID string) error {
	cmd := exec.Command("docker", "logs", "-f", containerID)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return errtrace.Wrap(cmd.Run())
}

// dockerfileForAgent returns the embedded Dockerfile content for the given agent type.
func dockerfileForAgent(agentType AgentType) (string, error) {
	switch agentType {
	case AgentTypeClaude:
		return config.DefaultDockerfileClaude, nil
	case AgentTypeGemini:
		return config.DefaultDockerfileGemini, nil
	default:
		return "", fmt.Errorf("unknown agent type: %q", agentType)
	}
}

// agentBinds returns host:container bind mounts for agent-specific config files.
// containerHome is the home directory of the agent user inside the container (e.g. /home/callum).
func agentBinds(agentType AgentType, containerHome string) []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}

	var binds []string
	switch agentType {
	case AgentTypeClaude:
		for _, pair := range []struct{ host, container string }{
			{filepath.Join(home, ".claude", "settings.json"), containerHome + "/.claude/settings.json"},
			{filepath.Join(home, ".claude", ".credentials.json"), containerHome + "/.claude/.credentials.json"},
		} {
			if _, err := os.Stat(pair.host); err == nil {
				binds = append(binds, pair.host+":"+pair.container+":ro")
			}
		}
	case AgentTypeGemini:
		for _, pair := range []struct{ host, container string }{
			{filepath.Join(home, ".gemini", "oauth_creds.json"), containerHome + "/.gemini/oauth_creds.json"},
			{filepath.Join(home, ".gemini", "google_accounts.json"), containerHome + "/.gemini/google_accounts.json"},
			{filepath.Join(home, ".gemini", "settings.json"), containerHome + "/.gemini/settings.json"},
		} {
			if _, err := os.Stat(pair.host); err == nil {
				binds = append(binds, pair.host+":"+pair.container+":ro")
			}
		}
	}
	return binds
}

// ensureImage builds the Docker image from content if an image with the same hash doesn't exist.
func ensureImage(ctx context.Context, cli *dockerclient.Client, agentType AgentType, content string) (string, error) {
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(content)))[:8]
	tag := "hydra-agent-" + string(agentType) + ":" + hash

	images, err := cli.ImageList(ctx, image.ListOptions{
		Filters: filters.NewArgs(filters.Arg("reference", tag)),
	})
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("list images: %w", err))
	}
	if len(images) > 0 {
		return tag, nil
	}

	// Write Dockerfile to a temp file for the build
	tmpFile, err := os.CreateTemp("", "hydra-*.Dockerfile")
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create temp dockerfile: %w", err))
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString(content); err != nil {
		tmpFile.Close()
		return "", errtrace.Wrap(fmt.Errorf("write temp dockerfile: %w", err))
	}
	tmpFile.Close()

	fmt.Printf("Building Docker image %s...\n", tag)
	buildCmd := exec.Command(
		"docker", "build",
		"-t", tag,
		"-f", tmpFile.Name(),
		filepath.Dir(tmpFile.Name()),
	)
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("build image: %w", err))
	}
	return tag, nil
}
