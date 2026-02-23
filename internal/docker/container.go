package docker

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"braces.dev/errtrace"
	"github.com/charmbracelet/x/term"
	"github.com/docker/docker/api/types/build"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	dockerclient "github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"github.com/trolleyman/hydra/internal/common"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
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
	UID            int
	GID            int
	Username       string
	GroupName      string
	Resume         bool // if true, run agent with --resume instead of a fresh prompt
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
	agentBinds, err := getAgentBinds(opts.AgentType, opts.ProjectPath, containerHome)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	binds = append(binds, agentBinds...)

	var netCfg *network.NetworkingConfig
	var platform *ocispec.Platform

	containerName := "hydra-" + opts.Id
	log.Printf("Creating container %s...", containerName)
	var cmd []string
	if opts.Resume {
		cmd = []string{"--resume"}
	} else {
		switch opts.AgentType {
		case AgentTypeClaude:
			// cmd = []string{"claude", "--dangerously-skip-permissions", "--", opts.Prompt}
			cmd = []string{"bash"}
		case AgentTypeGemini:
			cmd = []string{"gemini", "--approval-mode=yolo", "-i", opts.Prompt}
		default:
			return "", fmt.Errorf("unknown agent type: %q", opts.AgentType)
		}
	}

	resp, err := cli.ContainerCreate(ctx,
		&container.Config{
			Image:      imageTag,
			Cmd:        cmd,
			Labels:     map[string]string{LabelKey: labelVal},
			Tty:        true,
			OpenStdin:  true,
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
	log.Printf("Stopping container %s...", containerID[:12])
	if err := cli.ContainerStop(ctx, containerID, container.StopOptions{Timeout: &timeout}); err != nil {
		log.Printf("warn: stop container %s: %v", containerID[:12], err)
	}
	log.Printf("Removing container %s...", containerID[:12])
	if err := cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true}); err != nil {
		return errtrace.Wrap(fmt.Errorf("remove container: %w", err))
	}
	return nil
}

// AttachAgent runs attaches to a container, handing over the terminal.
func AttachAgent(ctx context.Context, cli *dockerclient.Client, containerID string) error {
	oldState, err := term.MakeRaw(os.Stdin.Fd())
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("set raw mode: %w", err))
	}
	defer term.Restore(os.Stdin.Fd(), oldState)

	resp, err := cli.ContainerAttach(ctx, containerID, container.AttachOptions{
		Stream: true,
		Stdin:  true,
		Stdout: true,
		Stderr: true,
	})
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("attach to container: %w", err))
	}
	defer resp.Close()

	// Send the initial terminal size so the container TUI knows how to render.
	syncTerminalSize(ctx, cli, containerID)

	// Inject a Ctrl+L byte (\x0c) into the container's stdin to force a TUI redraw.
	// We ignore the error here as a failed redraw signal shouldn't crash the attachment.
	_, _ = resp.Conn.Write([]byte{'\x0c'})

	// Listen for window resize events from the host OS and forward them to the container.
	// syscall.SIGWINCH is Unix-specific. If compiling for Windows, this signal won't fire,
	// but the initial sync above will at least give the container a starting size.
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGWINCH)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-sigChan:
				syncTerminalSize(ctx, cli, containerID)
			}
		}
	}()

	errCh := make(chan error, 2)

	go func() {
		_, err := io.Copy(resp.Conn, os.Stdin)
		resp.CloseWrite()
		errCh <- err
	}()

	go func() {
		_, err := io.Copy(os.Stdout, resp.Reader)
		errCh <- err
	}()

	err = <-errCh
	if err != nil && err != io.EOF {
		return errtrace.Wrap(fmt.Errorf("stream copy: %w", err))
	}

	return nil
}

func syncTerminalSize(ctx context.Context, cli *dockerclient.Client, containerID string) {
	width, height, err := term.GetSize(os.Stdout.Fd())
	if err != nil {
		return
	}

	// Tell the Docker daemon the new dimensions of the TTY.
	_ = cli.ContainerResize(ctx, containerID, container.ResizeOptions{
		Height: uint(height),
		Width:  uint(width),
	})
}

// ViewLogs runs `docker logs -f <id>`, streaming output to the terminal.
func ViewLogs(containerID string) error {
	cmd := exec.Command("docker", "logs", "-f", containerID)
	common.PrintExecCmd(cmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return errtrace.Wrap(cmd.Run())
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

// getAgentBinds returns host:container bind mounts for agent-specific config files.
// containerHome is the home directory of the agent user inside the container (e.g. /home/callum).
func getAgentBinds(agentType AgentType, projectRoot string, containerHome string) ([]string, error) {
	// home, err := os.UserHomeDir()
	// if err != nil {
	// 	return nil, errtrace.Wrap(err)
	// }

	hydraDir := paths.GetHydraDirFromProjectRoot(projectRoot)
	cacheDir := filepath.Join(hydraDir, "cache")
	if err := git.CreateGitignoreAllInDir(cacheDir); err != nil {
		return nil, errtrace.Wrap(err)
	}

	var binds []string
	switch agentType {
	case AgentTypeClaude:
		claudeSettingsDir := filepath.Join(cacheDir, ".claude")
		claudeSettingsJson := filepath.Join(claudeSettingsDir, "settings.json")
		if _, err := os.Stat(claudeSettingsJson); os.IsNotExist(err) {
			if err = os.WriteFile(claudeSettingsJson, []byte("{\"skipDangerousModePermissionPrompt\": true}"), 0644); err != nil {
				return nil, errtrace.Wrap(err)
			}
		}
		claudeJson := filepath.Join(cacheDir, ".claude.json")
		if _, err := os.Stat(claudeJson); os.IsNotExist(err) {
			if err = os.WriteFile(claudeJson, []byte("{}"), 0644); err != nil {
				return nil, errtrace.Wrap(err)
			}
		}

		for _, pair := range []struct{ host, container string }{
			{claudeSettingsDir, containerHome + "/.claude"},
			{claudeJson, containerHome + "/.claude.json"},
		} {
			if _, err := os.Stat(pair.host); err == nil {
				binds = append(binds, pair.host+":"+pair.container)
			}
		}
	case AgentTypeGemini:
		geminiSettingsDir := filepath.Join(cacheDir, ".gemini")

		for _, pair := range []struct{ host, container string }{
			{geminiSettingsDir, containerHome + "/.gemini"},
		} {
			if _, err := os.Stat(pair.host); err == nil {
				binds = append(binds, pair.host+":"+pair.container)
			}
		}
	}
	return binds, nil
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
	tag := "hydra-agent-" + string(agentType) + ":default"

	// Copy the embedded Dockerfile to a stable per-user directory.
	ctxDir, err := prepareDefaultDockerfileDir(agentType)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	err = buildDockerImage(ctx, cli, tag, filepath.Join(ctxDir, "Dockerfile"), ctxDir)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return tag, nil
}

func buildDockerImage(ctx context.Context, cli *dockerclient.Client, tag, dockerfilePath, buildContext string) error {
	log.Printf("Building Docker image: %s (from %s in %s)", tag, dockerfilePath, buildContext)

	// Docker expects the Dockerfile path to be relative to the build context root.
	relDockerfile, err := filepath.Rel(buildContext, dockerfilePath)
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("resolve relative dockerfile path: %w", err))
	}
	// Ensure the path uses forward slashes, as required by the Docker daemon.
	relDockerfile = filepath.ToSlash(relDockerfile)

	pr, pw := io.Pipe()
	errChan := make(chan error, 1)

	go func() {
		tw := tar.NewWriter(pw)
		var walkErr error

		defer func() {
			tw.Close()
			pw.CloseWithError(walkErr)
			errChan <- walkErr
		}()

		walkErr = filepath.Walk(buildContext, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}

			header, err := tar.FileInfoHeader(info, info.Name())
			if err != nil {
				return err
			}

			rel, err := filepath.Rel(buildContext, path)
			if err != nil {
				return err
			}

			// Docker expects forward slashes in tar headers regardless of the host OS
			header.Name = filepath.ToSlash(rel)

			if err := tw.WriteHeader(header); err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = io.Copy(tw, f)
			return err
		})
	}()

	resp, err := cli.ImageBuild(ctx, pr, build.ImageBuildOptions{
		Tags:       []string{tag},
		Dockerfile: relDockerfile, // Use the relative, slash-converted path here
	})
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("build image: %w", err))
	}
	defer resp.Body.Close()

	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		return errtrace.Wrap(fmt.Errorf("read build output: %w", err))
	}

	if err := <-errChan; err != nil {
		return errtrace.Wrap(fmt.Errorf("create build context archive: %w", err))
	}

	return nil
}

func ensureCustomImage(ctx context.Context, cli *dockerclient.Client, agentType AgentType, dockerfilePath string) (string, error) {
	abs, err := filepath.Abs(dockerfilePath)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("resolve dockerfile path: %w", err))
	}

	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(abs)))[:8]
	tag := "hydra-agent-" + string(agentType) + ":" + hash

	err = buildDockerImage(ctx, cli, tag, dockerfilePath, filepath.Dir(abs))
	if err != nil {
		return "", errtrace.Wrap(err)
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
