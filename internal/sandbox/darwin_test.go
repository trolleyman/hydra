//go:build darwin

package sandbox

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestBuildSpecDarwinImmutablePathOverridesWritableParent(t *testing.T) {
	worktree := t.TempDir()
	home := t.TempDir()
	immutable := filepath.Join(worktree, "policy.json")
	if err := os.WriteFile(immutable, []byte("seed"), 0o600); err != nil {
		t.Fatal(err)
	}

	spec, err := BuildSpec(Options{
		WorktreePath:   worktree,
		Home:           home,
		ImmutablePaths: []string{immutable},
		Env:            os.Environ(),
		Argv: []string{
			"/bin/sh", "-c",
			`test "$(cat "$1")" = seed || exit 41; printf changed >> "$1"`, "sh", immutable,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer spec.Cleanup()

	cmd := exec.Command(spec.Path, spec.Args[1:]...)
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	output, runErr := cmd.CombinedOutput()
	if nestedSandboxDenied(output) {
		t.Skip("sandbox-exec cannot nest inside the test runner's existing sandbox")
	}
	if runErr == nil {
		if profile, readErr := os.ReadFile(spec.Args[2]); readErr == nil {
			t.Logf("profile:\n%s", profile)
		}
		t.Fatal("sandboxed write to immutable input succeeded")
	}
	if data, err := os.ReadFile(immutable); err != nil {
		t.Fatal(err)
	} else if string(data) != "seed" {
		t.Fatalf("immutable input changed to %q", data)
	}
}

func TestCanonicalSBPathResolvesMacOSCompatibilityAliases(t *testing.T) {
	for input, want := range map[string]string{
		"/tmp": "/private/tmp",
		"/var": "/private/var",
	} {
		if got := canonicalSBPath(input); got != want {
			if _, err := filepath.EvalSymlinks(input); os.IsPermission(err) {
				t.Skip("the test runner sandbox hides macOS compatibility aliases")
			}
			t.Errorf("canonicalSBPath(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestBuildSpecDarwinPrivateTempPolicyAndEnvironment(t *testing.T) {
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	home := filepath.Join(root, "home")
	tmpDir := filepath.Join(root, "state", "tmp", "head-one")
	controlDir := filepath.Join(root, "runtime", "head-control", "random-key")
	for _, dir := range []string{worktree, home, tmpDir, controlDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	spec, err := BuildSpec(Options{
		WorktreePath:   worktree,
		Home:           home,
		TmpDir:         tmpDir,
		WritablePaths:  []string{controlDir},
		Env:            []string{"PATH=/usr/bin", "TMPDIR=/shared", "TMP=/shared", "TEMP=/shared"},
		PreSpawnScript: `printf 'FROM_HOOK=1\n' >> "$HYDRA_ENV"`,
		Argv:           []string{"/bin/sh"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer spec.Cleanup()

	for _, key := range []string{"TMPDIR", "TMP", "TEMP"} {
		want := key + "=" + tmpDir
		if !containsExact(spec.Env, want) {
			t.Errorf("spec.Env lacks %q: %v", want, spec.Env)
		}
	}
	if !strings.Contains(strings.Join(spec.Args, "\n"), filepath.Join(tmpDir, PreSpawnEnvFileName)) {
		t.Fatalf("pre-spawn wrapper does not persist under private temp: %v", spec.Args)
	}

	profileData, err := os.ReadFile(spec.Args[2])
	if err != nil {
		t.Fatal(err)
	}
	profile := string(profileData)
	tempDeny := `(deny file-read* file-write* ` + sbPathRule(os.TempDir()) + `)`
	parentMetadata := `(allow file-read-metadata ` + sbLiteralPathRule(filepath.Dir(tmpDir)) + `)`
	ownAllow := `(allow file-read* file-write* ` + sbPathRule(tmpDir) + `)`
	controlAllow := `(allow file-read* file-write* ` + sbPathRule(controlDir) + `)`
	denyAt := strings.Index(profile, tempDeny)
	metadataAt := strings.Index(profile, parentMetadata)
	ownAt := strings.Index(profile, ownAllow)
	controlAt := strings.Index(profile, controlAllow)
	if denyAt < 0 || metadataAt < 0 || ownAt < 0 || controlAt < 0 {
		t.Fatalf("private temp profile rules missing:\n%s", profile)
	}
	if !(denyAt < metadataAt && metadataAt < ownAt && denyAt < controlAt) {
		t.Fatalf("narrow temp/control grants must follow shared-temp denial:\n%s", profile)
	}
}

func TestBuildSpecDarwinPrivateTempSupportsCanonicalizingToolsWithoutExposingSiblings(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is unavailable")
	}
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	home := filepath.Join(root, "home")
	tmpRoot := filepath.Join(root, "state", "tmp")
	tmpDir := filepath.Join(tmpRoot, "head-one")
	siblingDir := filepath.Join(tmpRoot, "head-two")
	for _, dir := range []string{worktree, home, tmpDir, siblingDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	siblingSecret := filepath.Join(siblingDir, "secret")
	if err := os.WriteFile(siblingSecret, []byte("sibling"), 0o600); err != nil {
		t.Fatal(err)
	}

	spec, err := BuildSpec(Options{
		WorktreePath: worktree,
		Home:         home,
		TmpDir:       tmpDir,
		Env:          []string{"PATH=/usr/bin:/bin"},
		Argv: []string{
			"/bin/sh", "-c",
			`"$1" init -q "$TMPDIR/repo" || exit 41
if /bin/ls -A "$2" >/dev/null 2>&1; then exit 42; fi
if /bin/cat "$3" >/dev/null 2>&1; then exit 43; fi`,
			"sh", gitPath, tmpRoot, siblingSecret,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer spec.Cleanup()

	cmd := exec.Command(spec.Path, spec.Args[1:]...)
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	output, runErr := cmd.CombinedOutput()
	if nestedSandboxDenied(output) {
		t.Skip("sandbox-exec cannot nest inside the test runner's existing sandbox")
	}
	if runErr != nil {
		t.Fatalf("private temp compatibility/isolation probe failed: %v\n%s", runErr, output)
	}
}

func TestBuildSpecDarwinRejectsMountInputs(t *testing.T) {
	_, err := BuildSpec(Options{
		WorktreePath: t.TempDir(),
		Home:         t.TempDir(),
		Binds:        []Bind{{Source: "/source", Target: "/target"}},
		Argv:         []string{"/bin/true"},
	})
	if err == nil || !strings.Contains(err.Error(), "cannot apply mount-based inputs") {
		t.Fatalf("BuildSpec mount input error = %v", err)
	}
}

func TestBuildSpecDarwinHardEgressAllowsOnlyProxyAndConfiguredLoopback(t *testing.T) {
	spec, err := BuildSpec(Options{
		WorktreePath: t.TempDir(),
		Home:         t.TempDir(),
		Network: NetworkPolicy{
			Mode:                 NetHard,
			Enabled:              true,
			FilterHosts:          true,
			HardProxyPort:        43123,
			HardInboundPort:      38913,
			AllowedLoopbackPorts: []int{5037, 43123, 0, 70000},
		},
		Argv: []string{"/bin/true"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer spec.Cleanup()
	data, err := os.ReadFile(spec.Args[2])
	if err != nil {
		t.Fatal(err)
	}
	profile := string(data)
	deny := `(deny network-outbound (remote ip))`
	proxyAllow := `(allow network-outbound (remote tcp "localhost:43123"))`
	serviceAllow := `(allow network-outbound (remote tcp "localhost:5037"))`
	bindDeny := `(deny network-bind (local ip))`
	loopbackBind := `(allow network-bind (local tcp "localhost:*") (local udp "localhost:*"))`
	inboundBind := `(allow network-bind (local tcp "*:38913"))`
	for _, rule := range []string{deny, proxyAllow, serviceAllow, bindDeny, loopbackBind, inboundBind} {
		if !strings.Contains(profile, rule) {
			t.Errorf("hard-egress profile lacks %q:\n%s", rule, profile)
		}
	}
	if strings.Count(profile, proxyAllow) != 1 {
		t.Errorf("proxy port rule count = %d, want 1", strings.Count(profile, proxyAllow))
	}
	if strings.Contains(profile, "localhost:0") || strings.Contains(profile, "localhost:70000") {
		t.Fatalf("invalid loopback port reached profile:\n%s", profile)
	}
	if strings.Index(profile, deny) > strings.Index(profile, proxyAllow) {
		t.Fatalf("loopback allow must follow the general IP deny:\n%s", profile)
	}
}

func TestBuildSpecDarwinHardEgressRequiresProxyPort(t *testing.T) {
	_, err := BuildSpec(Options{
		WorktreePath: t.TempDir(),
		Home:         t.TempDir(),
		Network:      NetworkPolicy{Mode: NetHard, Enabled: true, FilterHosts: true},
		Argv:         []string{"/bin/true"},
	})
	if err == nil || !strings.Contains(err.Error(), "requires a valid filtering proxy port") {
		t.Fatalf("BuildSpec hard egress error = %v", err)
	}
}

func TestBuildSpecDarwinHardEgressEnforcesLoopbackPort(t *testing.T) {
	listen := func() net.Listener {
		t.Helper()
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			if strings.Contains(err.Error(), "operation not permitted") {
				t.Skip("test runner sandbox cannot open loopback listeners")
			}
			t.Fatal(err)
		}
		return ln
	}
	allowed := listen()
	defer allowed.Close()
	blocked := listen()
	defer blocked.Close()
	allowedPort := allowed.Addr().(*net.TCPAddr).Port
	blockedPort := blocked.Addr().(*net.TCPAddr).Port

	received := make(chan error, 1)
	go func() {
		conn, err := allowed.Accept()
		if err != nil {
			received <- err
			return
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		buf := make([]byte, 2)
		if _, err := io.ReadFull(conn, buf); err != nil {
			received <- err
			return
		}
		if string(buf) != "ok" {
			received <- fmt.Errorf("received %q, want ok", buf)
			return
		}
		received <- nil
	}()

	spec, err := BuildSpec(Options{
		WorktreePath: t.TempDir(),
		Home:         t.TempDir(),
		Network: NetworkPolicy{
			Mode:          NetHard,
			Enabled:       true,
			FilterHosts:   true,
			HardProxyPort: allowedPort,
		},
		Argv: []string{
			"/bin/bash", "-c",
			`exec 3<>/dev/tcp/127.0.0.1/$1 || exit 41; printf ok >&3; if exec 4<>/dev/tcp/127.0.0.1/$2 2>/dev/null; then exit 42; fi`,
			"bash", strconv.Itoa(allowedPort), strconv.Itoa(blockedPort),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer spec.Cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, spec.Path, spec.Args[1:]...)
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	output, runErr := cmd.CombinedOutput()
	if nestedSandboxDenied(output) {
		t.Skip("sandbox-exec cannot nest inside the test runner's existing sandbox")
	}
	if runErr != nil {
		t.Fatalf("hard-egress probe failed: %v\n%s", runErr, output)
	}
	select {
	case err := <-received:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("allowed loopback listener received no connection")
	}
}

func TestBuildSpecDarwinHardensGUIAndSignals(t *testing.T) {
	spec, err := BuildSpec(Options{
		WorktreePath: t.TempDir(),
		Home:         t.TempDir(),
		HardenGUI:    true,
		Env: []string{
			"PATH=/usr/bin",
			"DISPLAY=:0",
			"WAYLAND_DISPLAY=wayland-0",
			"XAUTHORITY=/tmp/xauth",
			"DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus",
		},
		Argv: []string{"/bin/true"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer spec.Cleanup()
	for _, entry := range spec.Env {
		for _, key := range []string{"DISPLAY=", "WAYLAND_DISPLAY=", "XAUTHORITY=", "DBUS_SESSION_BUS_ADDRESS="} {
			if strings.HasPrefix(entry, key) {
				t.Errorf("GUI environment leaked %q", entry)
			}
		}
	}
	if !containsExact(spec.Env, "PATH=/usr/bin") {
		t.Errorf("GUI hardening dropped unrelated environment: %v", spec.Env)
	}
	data, err := os.ReadFile(spec.Args[2])
	if err != nil {
		t.Fatal(err)
	}
	profile := string(data)
	for _, rule := range []string{
		`(deny signal)`,
		`(allow signal (target self))`,
		`(allow signal (target children))`,
		`(deny mach-lookup (global-name "com.apple.windowserver.active"))`,
		`(deny mach-lookup (global-name "com.apple.pasteboard.1"))`,
		`(deny mach-lookup (global-name "com.apple.coreservices.appleevents"))`,
	} {
		if !strings.Contains(profile, rule) {
			t.Errorf("hardened profile lacks %q:\n%s", rule, profile)
		}
	}
}

func TestCowCloneDarwinCreatesPrivateWritableCopy(t *testing.T) {
	root := t.TempDir()
	lower := filepath.Join(root, "lower")
	dest := filepath.Join(root, "dest")
	for _, dir := range []string{lower, dest} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(lower, "input.txt"), []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	mount := CowMount{Lower: lower, Dest: dest, Upper: filepath.Join(root, "writable-marker")}
	if err := cowClone(mount); err != nil {
		t.Fatal(err)
	}
	copyPath := filepath.Join(dest, "input.txt")
	if data, err := os.ReadFile(copyPath); err != nil || string(data) != "source" {
		t.Fatalf("clone contents = %q, %v", data, err)
	}
	if err := os.WriteFile(copyPath, []byte("private edit"), 0o600); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(lower, "input.txt")); err != nil || string(data) != "source" {
		t.Fatalf("editing clone changed source: %q, %v", data, err)
	}
	if err := cowClone(mount); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(copyPath); err != nil || string(data) != "private edit" {
		t.Fatalf("resume clone overwrote private edit: %q, %v", data, err)
	}
}

func containsExact(entries []string, want string) bool {
	for _, entry := range entries {
		if entry == want {
			return true
		}
	}
	return false
}

func nestedSandboxDenied(output []byte) bool {
	text := string(output)
	return strings.Contains(text, "sandbox_apply: Operation not permitted") ||
		(strings.Contains(text, "sandbox-exec:") && strings.Contains(text, "Operation not permitted"))
}
