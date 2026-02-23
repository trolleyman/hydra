package docker

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"braces.dev/errtrace"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	dockerclient "github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"github.com/trolleyman/hydra/internal/common"
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
	DockerfilePath string // optional; empty = use embedded default for AgentType
	Prompt         string
	ProjectPath    string
	WorktreePath   string
	BranchName     string
	BaseBranch     string
	GitAuthorName  string
	GitAuthorEmail string
}

// SpawnAgent builds the Docker image if necessary, then creates and starts the container.
// Returns the container ID.
func SpawnAgent(ctx context.Context, cli *dockerclient.Client, opts SpawnOptions) (string, error) {
	imageTag, err := ensureImage(ctx, cli, opts.AgentType, opts.DockerfilePath)
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
	binds = append(binds, agentBinds(opts.AgentType)...)

	var netCfg *network.NetworkingConfig
	var platform *ocispec.Platform

	containerName := "hydra-" + opts.Id
	log.Printf("Creating container %s...", containerName)
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
	common.PrintExecCmd(cmd)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return errtrace.Wrap(cmd.Run())
}

// ViewLogs runs `docker logs -f <id>`, streaming output to the terminal.
func ViewLogs(containerID string) error {
	cmd := exec.Command("docker", "logs", "-f", containerID)
	common.PrintExecCmd(cmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return errtrace.Wrap(cmd.Run())
}

// InferAgentType parses Dockerfile content and returns the agent type inferred
// from the ENTRYPOINT command name (e.g. "claude" or "gemini").
func InferAgentType(content string) (AgentType, bool) {
	for line := range strings.SplitSeq(content, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(strings.ToUpper(line), "ENTRYPOINT") {
			continue
		}
		rest := strings.TrimSpace(line[len("ENTRYPOINT"):])
		var cmdName string
		if rest, ok := strings.CutPrefix(rest, "["); ok {
			// JSON array form: ENTRYPOINT ["cmd", ...]
			rest = strings.TrimSpace(rest)
			if len(rest) > 0 && (rest[0] == '"' || rest[0] == '\'') {
				q := rest[0]
				end := strings.IndexByte(rest[1:], q)
				if end >= 0 {
					cmdName = rest[1 : 1+end]
				}
			}
		} else {
			// Shell form: ENTRYPOINT cmd args...
			parts := strings.Fields(rest)
			if len(parts) > 0 {
				cmdName = strings.Trim(parts[0], `"'`)
			}
		}
		if cmdName == "" {
			continue
		}
		// Use basename so paths like /usr/bin/claude still match.
		switch AgentType(filepath.Base(cmdName)) {
		case AgentTypeClaude, AgentTypeGemini:
			return AgentType(filepath.Base(cmdName)), true
		}
	}
	return "", false
}

// defaultDockerfileContent returns the embedded Dockerfile content for the given agent type.
func defaultDockerfileContent(agentType AgentType) (string, error) {
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
func agentBinds(agentType AgentType) []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}

	var binds []string
	switch agentType {
	case AgentTypeClaude:
		for _, pair := range []struct{ host, container string }{
			{filepath.Join(home, ".claude", "settings.json"), "/root/.claude/settings.json"},
			{filepath.Join(home, ".claude", ".credentials.json"), "/root/.claude/.credentials.json"},
		} {
			if _, err := os.Stat(pair.host); err == nil {
				binds = append(binds, pair.host+":"+pair.container+":ro")
			}
		}
	case AgentTypeGemini:
		for _, pair := range []struct{ host, container string }{
			{filepath.Join(home, ".gemini", "oauth_creds.json"), "/root/.gemini/oauth_creds.json"},
			{filepath.Join(home, ".gemini", "google_accounts.json"), "/root/.gemini/google_accounts.json"},
			{filepath.Join(home, ".gemini", "settings.json"), "/root/.gemini/settings.json"},
		} {
			if _, err := os.Stat(pair.host); err == nil {
				binds = append(binds, pair.host+":"+pair.container+":ro")
			}
		}
	}
	return binds
}

// ensureImage ensures the Docker image for the given agent and optional custom
// Dockerfile exists, building it if necessary. Returns the image tag.
//
// Default images (customDockerfile == ""):
//   - Copies the embedded Dockerfile to ~/.hydra/default_dockerfiles/<type>/Dockerfile
//   - Tag: hydra-agent-<type>
//
// Custom images (customDockerfile != ""):
//   - Uses the provided Dockerfile; build context is its parent directory
//   - Tag: hydra-agent-<type>-<sha256(absPath)[:8]>
func ensureImage(ctx context.Context, cli *dockerclient.Client, agentType AgentType, customDockerfile string) (string, error) {
	if customDockerfile == "" {
		return ensureDefaultImage(ctx, cli, agentType)
	}
	return ensureCustomImage(ctx, cli, agentType, customDockerfile)
}

func ensureDefaultImage(ctx context.Context, cli *dockerclient.Client, agentType AgentType) (string, error) {
	tag := "hydra-agent-" + string(agentType)

	images, err := cli.ImageList(ctx, image.ListOptions{
		Filters: filters.NewArgs(filters.Arg("reference", tag)),
	})
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("list images: %w", err))
	}
	if len(images) > 0 {
		return tag, nil
	}

	// Copy the embedded Dockerfile to a stable per-user directory.
	ctxDir, err := prepareDefaultDockerfileDir(agentType)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	buildCmd := exec.Command(
		"docker", "build",
		"-t", tag,
		"-f", filepath.Join(ctxDir, "Dockerfile"),
		ctxDir,
	)
	common.PrintExecCmd(buildCmd)
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("build image: %w", err))
	}
	return tag, nil
}

func ensureCustomImage(ctx context.Context, cli *dockerclient.Client, agentType AgentType, dockerfilePath string) (string, error) {
	abs, err := filepath.Abs(dockerfilePath)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("resolve dockerfile path: %w", err))
	}

	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(abs)))[:8]
	tag := "hydra-agent-" + string(agentType) + "-" + hash

	images, err := cli.ImageList(ctx, image.ListOptions{
		Filters: filters.NewArgs(filters.Arg("reference", tag)),
	})
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("list images: %w", err))
	}
	if len(images) > 0 {
		return tag, nil
	}

	buildCmd := exec.Command(
		"docker", "build",
		"-t", tag,
		"-f", abs,
		filepath.Dir(abs),
	)
	common.PrintExecCmd(buildCmd)
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("build image: %w", err))
	}
	return tag, nil
}

// prepareDefaultDockerfileDir ensures ~/.hydra/default_dockerfiles/<type>/Dockerfile
// exists with the current embedded content and returns the directory path.
func prepareDefaultDockerfileDir(agentType AgentType) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get home dir: %w", err))
	}
	dir := filepath.Join(home, ".hydra", "default_dockerfiles", string(agentType))
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create dockerfile dir: %w", err))
	}

	content, err := defaultDockerfileContent(agentType)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	dockerfilePath := filepath.Join(dir, "Dockerfile")
	existing, readErr := os.ReadFile(dockerfilePath)
	if readErr != nil || string(existing) != content {
		if err := os.WriteFile(dockerfilePath, []byte(content), 0644); err != nil {
			return "", errtrace.Wrap(fmt.Errorf("write default dockerfile: %w", err))
		}
	}
	return dir, nil
}
