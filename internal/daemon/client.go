package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"

	"braces.dev/errtrace"
	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/api"
)

// baseURL is a placeholder host; the transport always dials the unix socket.
const baseURL = "http://hydra"

// Client talks to a project's hydrad over its unix control socket.
type Client struct {
	sock      string
	http      *http.Client
	ProjectID string
}

// unixHTTPClient returns an HTTP client whose connections always go to sock.
func unixHTTPClient(sock string) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return errtrace.Wrap2(d.DialContext(ctx, "unix", sock))
			},
		},
		Timeout: 60 * time.Second,
	}
}

// Connect returns a client for the project's daemon, auto-starting it if needed.
func Connect(ctx context.Context, projectRoot string) (*Client, error) {
	sock, err := SocketPath(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	c := &Client{sock: sock, http: unixHTTPClient(sock)}
	running := c.ping(ctx)
	// Auto-upgrade: if the running daemon was started from a now-replaced
	// binary, drain + restart it so the new code takes effect. Heads are
	// resumed on the new daemon's boot.
	// A service-managed daemon is not ours to evict: SIGTERMing it and spawning
	// a detached replacement would leave systemd's unit inactive with an
	// unsupervised daemon running behind it. Say so and keep talking to the one
	// that is there - it is only running older code, which is a smaller problem
	// than two daemons fighting over one socket.
	if running && isStale(projectRoot) && IsServiceManaged(projectRoot) {
		fmt.Fprintln(os.Stderr,
			"note: the running hydra daemon is service-managed and was started from an older binary.\n"+
				"      Use the web UI's update button, or `systemctl --user restart hydra`, to pick this one up.")
	} else if running && isStale(projectRoot) {
		if err := StopDaemon(ctx, projectRoot); err != nil {
			return nil, errtrace.Wrap(err)
		}
		running = false
	}
	if !running {
		if err := EnsureRunning(ctx, projectRoot); err != nil {
			return nil, errtrace.Wrap(err)
		}
	}

	st, err := c.Status(ctx)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("daemon status: %w", err))
	}
	if st.DefaultProjectId == nil {
		return nil, errtrace.Errorf("daemon did not report a default project")
	}
	c.ProjectID = *st.DefaultProjectId
	return c, nil
}

// ping reports whether the daemon answers /health.
func (c *Client) ping(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/health", nil)
	if err != nil {
		return false
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode == http.StatusOK
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return errtrace.Wrap(err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, baseURL+path, reader)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errtrace.Wrap(fmt.Errorf("daemon %s %s: %s: %s", method, path, resp.Status, string(data)))
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return errtrace.Wrap(fmt.Errorf("decode response: %w", err))
		}
	}
	return nil
}

// Status fetches the daemon status.
func (c *Client) Status(ctx context.Context) (*api.StatusResponse, error) {
	var st api.StatusResponse
	if err := c.do(ctx, http.MethodGet, "/api/status", nil, &st); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return &st, nil
}

// ListAgents returns the agents for the default project.
func (c *Client) ListAgents(ctx context.Context) ([]api.AgentResponse, error) {
	var agents []api.AgentResponse
	if err := c.do(ctx, http.MethodGet, "/api/projects/"+c.ProjectID+"/agents", nil, &agents); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return agents, nil
}

// SpawnAgent asks the daemon to spawn an agent.
func (c *Client) SpawnAgent(ctx context.Context, body api.SpawnAgentRequest) (*api.AgentResponse, error) {
	var resp api.AgentResponse
	if err := c.do(ctx, http.MethodPost, "/api/projects/"+c.ProjectID+"/agents", body, &resp); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return &resp, nil
}

// KillAgent asks the daemon to kill an agent.
func (c *Client) KillAgent(ctx context.Context, id string) error {
	return errtrace.Wrap(c.do(ctx, http.MethodDelete, "/api/projects/"+c.ProjectID+"/agents/"+id, nil, nil))
}

// MergeAgent asks the daemon to merge an agent's branch into its base and, when
// close is true, tear it down, archiving it with end_state "merged". Used by the
// `hydra merge` CLI so a merge is recorded as a merge (the kill path would
// mislabel it "killed"). close=false keeps the head running after the merge.
func (c *Client) MergeAgent(ctx context.Context, id string, close bool) error {
	url := "/api/projects/" + c.ProjectID + "/agents/" + id + "/merge"
	if !close {
		url += "?close=false"
	}
	return errtrace.Wrap(c.do(ctx, http.MethodPost, url, nil, nil))
}

// SetAgentBaseBranch updates the base branch an agent is considered based on.
// This is a metadata-only change (used by update-from-base and the diff view);
// it does not move the agent's commits. Returns the updated agent.
func (c *Client) SetAgentBaseBranch(ctx context.Context, id, baseBranch string) (*api.AgentResponse, error) {
	body := api.UpdateAgentRequest{BaseBranch: &baseBranch}
	var resp api.AgentResponse
	if err := c.do(ctx, http.MethodPatch, "/api/projects/"+c.ProjectID+"/agents/"+id, body, &resp); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return &resp, nil
}

// DialTerminal opens a websocket to the agent's terminal (or its shell tab).
func (c *Client) DialTerminal(id string, shell bool) (*websocket.Conn, error) {
	dialer := &websocket.Dialer{
		NetDial: func(_, _ string) (net.Conn, error) {
			return errtrace.Wrap2(net.Dial("unix", c.sock))
		},
		HandshakeTimeout: 10 * time.Second,
	}
	url := "ws://hydra/ws/projects/" + c.ProjectID + "/agents/" + id + "/terminal"
	if shell {
		url += "?shell=true"
	}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return conn, nil
}
