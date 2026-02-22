package docker

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"slices"

	"braces.dev/errtrace"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	dockerclient "github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// Agent represents a running or stopped Hydra-managed container.
type Agent struct {
	ContainerID string
	Status      string
	ImageName   string
	Meta        *AgentMetadata
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
		agents = append(agents, Agent{
			ContainerID: c.ID,
			Status:      c.Status,
			ImageName:   c.Image,
			Meta:        meta,
		})
	}
	return agents, nil
}

// SpawnOptions holds all configuration for launching a new agent container.
type SpawnOptions struct {
	Id             string
	Args           string
	Prompt         string
	ProjectPath    string
	WorktreePath   string
	BranchName     string
	BaseBranch     string
	DockerfilePath string
	GitAuthorName  string
	GitAuthorEmail string
}

// SpawnAgent builds the Docker image if necessary, then creates and starts the container.
// Returns the container ID.
func SpawnAgent(ctx context.Context, cli *dockerclient.Client, opts SpawnOptions) (string, error) {
	imageTag, err := ensureImage(ctx, cli, opts.DockerfilePath)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("ensure image: %w", err))
	}

	meta := &AgentMetadata{
		ProjectPath:      opts.ProjectPath,
		HostWorktreePath: opts.WorktreePath,
		BranchName:       opts.BranchName,
		BaseBranch:       opts.BaseBranch,
	}
	labelVal, err := EncodeLabel(meta)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("encode label: %w", err))
	}

	env := []string{}
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

	binds := []string{opts.WorktreePath + ":/app:rw"}

	// TODO: Add binds depending on AI agent type (auth, config, etc.)

	var netCfg *network.NetworkingConfig
	var platform *ocispec.Platform

	log.Printf("Creating container for agent %s...", opts.Id)
	resp, err := cli.ContainerCreate(ctx,
		&container.Config{
			Image:      imageTag,
			Cmd:        []string{opts.Prompt},
			Labels:     map[string]string{LabelKey: labelVal},
			Tty:        true,
			Env:        env,
			WorkingDir: "/app",
		},
		&container.HostConfig{
			Binds: binds,
		},
		netCfg,
		platform,
		"",
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

// ensureImage builds the Docker image if an image with the same Dockerfile hash doesn't exist.
func ensureImage(ctx context.Context, cli *dockerclient.Client, dockerfilePath string) (string, error) {
	data, err := os.ReadFile(dockerfilePath)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("read dockerfile: %w", err))
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(slices.Concat([]byte(dockerfilePath), data)))[:8]
	tag := "hydra-agent:" + hash

	images, err := cli.ImageList(ctx, image.ListOptions{
		Filters: filters.NewArgs(filters.Arg("reference", tag)),
	})
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("list images: %w", err))
	}
	if len(images) > 0 {
		return tag, nil
	}

	fmt.Printf("Building Docker image %s from %s...\n", tag, dockerfilePath)
	buildCmd := exec.Command(
		"docker", "build",
		"-t", tag,
		"-f", dockerfilePath,
		filepath.Dir(dockerfilePath),
	)
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("build image: %w", err))
	}
	return tag, nil
}
