//go:build unix

package preview

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/config"
)

// testPorts is a range away from the real preview default so tests never
// collide with a running daemon.
const testPorts = "38710-38740"

// newRoot writes a minimal project config (pinning the test port range) into a
// fresh temp dir and returns it as the project root.
func newRoot(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := config.GetProjectConfigPath(dir)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("preview_ports = \""+testPorts+"\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// fastManager returns a Manager with tiny timing knobs. Specs in tests use
// UnsafeHost so no sandbox tooling (bwrap) is required, mirroring the services
// tests' posture.
func fastManager() *Manager {
	m := NewManager("127.0.0.1", nil)
	m.readyDefault = 5 * time.Second
	m.idleDefault = 250 * time.Millisecond
	m.stopGrace = 100 * time.Millisecond
	m.reapInterval = 25 * time.Millisecond
	return m
}

// pythonServerSpec is a server artifact that serves the checkout over HTTP.
func pythonServerSpec(t *testing.T) config.ArtifactScript {
	t.Helper()
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	return config.ArtifactScript{
		Name:       "demo",
		Type:       config.ArtifactTypeServer,
		Command:    `exec python3 -m http.server "$HYDRA_PREVIEW_PORT" --bind 127.0.0.1 --directory .`,
		UnsafeHost: true,
	}
}

// worktreeVersion fabricates a live-worktree version backed by a temp dir
// holding one marker file.
func worktreeVersion(t *testing.T, headID, content string) Version {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return Version{HeadID: headID, WorktreeDir: dir}
}

// get performs a plain (non-HTML) GET against the instance's proxy port; it
// blocks through the starting state like an app fetch would.
func get(t *testing.T, port int, path string) (int, string) {
	t.Helper()
	c := &http.Client{Timeout: 15 * time.Second}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d%s", port, path))
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func waitState(t *testing.T, m *Manager, root string, spec config.ArtifactScript, v Version, want State, timeout time.Duration) Status {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var st Status
	for time.Now().Before(deadline) {
		st = m.Peek(root, spec, v)
		if st.State == want {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("state = %q (msg %q), want %q", st.State, st.Message, want)
	return st
}

// TestSpawnProxyRoundTrip covers the core path: Ensure allocates a port from
// the configured range, the first request spawns the child, waits for
// readiness, and proxies through to it.
func TestSpawnProxyRoundTrip(t *testing.T) {
	spec := pythonServerSpec(t)
	m := fastManager()
	m.idleDefault = time.Minute // no teardown during this test
	defer m.StopAll()
	root := newRoot(t)
	v := worktreeVersion(t, "h1", "roundtrip-body")

	st, err := m.Ensure(root, spec, v)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	lo, hi, _ := config.ParsePortRange(testPorts)
	if st.Port < lo || st.Port > hi {
		t.Fatalf("port %d outside configured range %s", st.Port, testPorts)
	}
	if st.Version != "uncommitted" {
		t.Fatalf("version label = %q, want uncommitted", st.Version)
	}

	code, body := get(t, st.Port, "/hello.txt")
	if code != 200 || !strings.Contains(body, "roundtrip-body") {
		t.Fatalf("proxied GET = %d %q", code, body)
	}
	if st := m.Peek(root, spec, v); st.State != StateRunning || st.Pid == 0 {
		t.Fatalf("after request: %+v", st)
	}
}

// TestLoadingPageWhileStarting checks a browser navigation during startup gets
// the holding page (not a hung request), and the status endpoint reports state.
func TestLoadingPageWhileStarting(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	spec := config.ArtifactScript{
		Name: "slow", Type: config.ArtifactTypeServer,
		Command: "sleep 60", UnsafeHost: true,
	}
	m := fastManager()
	m.idleDefault = time.Minute
	defer m.StopAll()
	root := newRoot(t)
	v := worktreeVersion(t, "h2", "x")

	st, err := m.Ensure(root, spec, v)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}

	req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/", st.Port), nil)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), "Starting") {
		t.Fatalf("loading page = %d %q", resp.StatusCode, string(body)[:min(len(body), 200)])
	}

	code, sbody := get(t, st.Port, statusPrefix+"status")
	if code != 200 || !strings.Contains(sbody, `"state":"starting"`) {
		t.Fatalf("status endpoint = %d %q", code, sbody)
	}
}

// TestIdleTeardownAndRespawn checks the reaper kills an idle child (process
// group and all) and that the next request transparently respawns it.
func TestIdleTeardownAndRespawn(t *testing.T) {
	spec := pythonServerSpec(t)
	m := fastManager()
	defer m.StopAll()
	root := newRoot(t)
	v := worktreeVersion(t, "h3", "respawn-body")

	st, err := m.Ensure(root, spec, v)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if code, _ := get(t, st.Port, "/hello.txt"); code != 200 {
		t.Fatalf("initial GET = %d", code)
	}
	pid := m.Peek(root, spec, v).Pid

	// Drive the reaper manually past the idle deadline.
	deadline := time.Now().Add(5 * time.Second)
	for m.Peek(root, spec, v).State != StateStopped {
		if time.Now().After(deadline) {
			t.Fatalf("never idled out: %+v", m.Peek(root, spec, v))
		}
		time.Sleep(30 * time.Millisecond)
		m.reap()
	}
	// The process group must actually be gone (SIGKILL after grace).
	waitDead(t, pid)

	// Same port, next request respawns.
	code, body := get(t, st.Port, "/hello.txt")
	if code != 200 || !strings.Contains(body, "respawn-body") {
		t.Fatalf("respawn GET = %d %q", code, body)
	}
	if again := m.Peek(root, spec, v); again.Port != st.Port {
		t.Fatalf("port changed across respawn: %d -> %d", st.Port, again.Port)
	}
}

// TestReadyMarker checks an explicit ::hydra:server:ready:: line flips the
// instance to running even though nothing listens on the child port.
func TestReadyMarker(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	spec := config.ArtifactScript{
		Name: "marker", Type: config.ArtifactTypeServer,
		Command: `echo "` + ReadyMarker + `"; sleep 60`, UnsafeHost: true,
	}
	m := fastManager()
	m.idleDefault = time.Minute
	defer m.StopAll()
	root := newRoot(t)
	v := worktreeVersion(t, "h4", "x")

	if _, err := m.Ensure(root, spec, v); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	waitState(t, m, root, spec, v, StateRunning, 5*time.Second)
}

// TestNeverReadyErrorsWithLog checks the ready deadline kills a spawn that
// never binds and surfaces the failure (state, message, captured log).
func TestNeverReadyErrorsWithLog(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	spec := config.ArtifactScript{
		Name: "wedged", Type: config.ArtifactTypeServer,
		Command: "echo building things; sleep 60", UnsafeHost: true,
	}
	m := fastManager()
	m.readyDefault = 400 * time.Millisecond
	m.idleDefault = time.Minute
	defer m.StopAll()
	root := newRoot(t)
	v := worktreeVersion(t, "h5", "x")

	if _, err := m.Ensure(root, spec, v); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	st := waitState(t, m, root, spec, v, StateError, 10*time.Second)
	if st.Message == "" {
		t.Fatalf("error state carries no message: %+v", st)
	}
	found := false
	for _, l := range st.Log {
		if strings.Contains(l.Text, "building things") {
			found = true
		}
	}
	if !found {
		t.Fatalf("captured log missing script output: %+v", st.Log)
	}
}

// TestWorktreeGoneReaper checks an instance whose live worktree vanished (head
// killed through any path) is removed entirely.
func TestWorktreeGoneReaper(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	spec := config.ArtifactScript{
		Name: "wt", Type: config.ArtifactTypeServer,
		Command: "sleep 60", UnsafeHost: true,
	}
	m := fastManager()
	m.idleDefault = time.Minute
	defer m.StopAll()
	root := newRoot(t)

	dir := filepath.Join(t.TempDir(), "wt")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	v := Version{HeadID: "h6", WorktreeDir: dir}
	st, err := m.Ensure(root, spec, v)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if st.Port == 0 {
		t.Fatal("no port allocated")
	}

	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	m.reap()
	if after := m.Peek(root, spec, v); after.Port != 0 || after.State != StateStopped {
		t.Fatalf("instance survived worktree removal: %+v", after)
	}
}

// TestStopHeadAndStopAll checks explicit teardown paths kill the child process
// group promptly.
func TestStopHeadAndStopAll(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	spec := config.ArtifactScript{
		Name: "sleeper", Type: config.ArtifactTypeServer,
		Command: "sleep 60", UnsafeHost: true,
	}
	m := fastManager()
	m.idleDefault = time.Minute
	defer m.StopAll()
	root := newRoot(t)
	v := worktreeVersion(t, "h7", "x")

	if _, err := m.Ensure(root, spec, v); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	var pid int
	for pid == 0 && time.Now().Before(deadline) {
		pid = m.Peek(root, spec, v).Pid
		time.Sleep(10 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("child never got a pid")
	}

	m.StopHead(root, "h7")
	waitDead(t, pid)
	if after := m.Peek(root, spec, v); after.Port != 0 {
		t.Fatalf("StopHead left the instance: %+v", after)
	}
}

// TestAuthGate checks the Authorizer fronts every proxied path, including the
// reserved status endpoint.
func TestAuthGate(t *testing.T) {
	spec := pythonServerSpec(t)
	m := fastManager()
	m.idleDefault = time.Minute
	m.auth = headerAuth{}
	defer m.StopAll()
	root := newRoot(t)
	v := worktreeVersion(t, "h8", "secret-body")

	st, err := m.Ensure(root, spec, v)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}

	for _, path := range []string{"/hello.txt", statusPrefix + "status"} {
		req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d%s", st.Port, path), nil)
		resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauthenticated %s = %d, want 401", path, resp.StatusCode)
		}
	}

	req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/hello.txt", st.Port), nil)
	req.Header.Set("X-Test-Auth", "yes")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("authed GET: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), "secret-body") {
		t.Fatalf("authed GET = %d %q", resp.StatusCode, string(body))
	}
}

// headerAuth authorizes requests carrying X-Test-Auth: yes.
type headerAuth struct{}

func (headerAuth) Authorized(r *http.Request) bool { return r.Header.Get("X-Test-Auth") == "yes" }

// TestCommitCheckoutLifecycle checks a commit-pinned version materializes its
// own detached checkout under .hydra/local/artifacts/preview and removes it on
// full teardown.
func TestCommitCheckoutLifecycle(t *testing.T) {
	spec := pythonServerSpec(t)
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	root := newRoot(t)
	mustGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	mustGit("init", "-q")
	if err := os.WriteFile(filepath.Join(root, "pinned.txt"), []byte("pinned-body"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit("add", ".")
	mustGit("commit", "-qm", "init")
	shaOut, err := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	sha := strings.TrimSpace(string(shaOut))

	m := fastManager()
	m.idleDefault = time.Minute
	defer m.StopAll()
	v := Version{SHA: sha}

	st, err := m.Ensure(root, spec, v)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if st.Version != sha[:8] {
		t.Fatalf("version label = %q, want %q", st.Version, sha[:8])
	}
	code, body := get(t, st.Port, "/pinned.txt")
	if code != 200 || !strings.Contains(body, "pinned-body") {
		t.Fatalf("commit-pinned GET = %d %q", code, body)
	}

	checkouts := filepath.Join(previewDir(root), "checkouts")
	entries, err := os.ReadDir(checkouts)
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected 1 preview checkout, got %v (err %v)", entries, err)
	}

	m.StopAll()
	if entries, err := os.ReadDir(checkouts); err == nil && len(entries) != 0 {
		t.Fatalf("checkout not removed on StopAll: %v", entries)
	}
}

// waitDead polls until pid no longer exists (kill(pid, 0) fails).
func waitDead(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err != nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("pid %d still alive", pid)
}
