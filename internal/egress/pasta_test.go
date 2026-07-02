package egress

import (
	"strings"
	"testing"
)

func TestHardWrapArgvShape(t *testing.T) {
	hm := HardMode{Available: true, PastaPath: "/usr/bin/pasta", NftPath: "/usr/sbin/nft"}
	bwrap := []string{"/usr/bin/bwrap", "--ro-bind", "/", "/", "--", "claude"}
	argv := HardWrapArgv(hm, 54321, bwrap, "")

	if argv[0] != "/usr/bin/pasta" {
		t.Fatalf("argv[0] should be pasta, got %q", argv[0])
	}
	// pasta must map the host loopback to the deterministic address used by both
	// the nft rule and HTTP_PROXY.
	if !contains(argv, "--map-host-loopback") || !contains(argv, MapAddr) {
		t.Errorf("missing --map-host-loopback %s: %v", MapAddr, argv)
	}
	// The bwrap argv must be passed verbatim as the command pasta runs (after the
	// `bash -c <script> bash` handoff), so exec "$@" runs it.
	joined := strings.Join(argv, " ")
	if !strings.Contains(joined, `exec "$@"`) {
		t.Error("wrap must exec the positional bwrap argv")
	}
	if !strings.HasSuffix(joined, strings.Join(bwrap, " ")) {
		t.Errorf("bwrap argv must be the trailing args: %v", argv)
	}
	// The nft lock must reference the proxy port and the map address.
	if !strings.Contains(joined, "tcp dport 54321") || !strings.Contains(joined, "ip daddr "+MapAddr) {
		t.Errorf("nft rule missing port/addr: %s", joined)
	}
	// Default-drop policy is the whole point.
	if !strings.Contains(joined, "policy drop") {
		t.Error("nft ruleset must default-drop egress")
	}
}

func TestHardWrapArgvInjectsPreExec(t *testing.T) {
	hm := HardMode{Available: true, PastaPath: "/usr/bin/pasta", NftPath: "/usr/sbin/nft"}
	bwrap := []string{"/usr/bin/bwrap", "--seccomp", "3", "--", "claude"}
	pre := "exec 3<\"/tmp/hydra-seccomp-x\"\nrm -f \"/tmp/hydra-seccomp-x\"\n"
	argv := HardWrapArgv(hm, 54321, bwrap, pre)

	// The script pasta runs is the -c argument (index after "bash", "-c").
	var script string
	for i, a := range argv {
		if a == "-c" && i+1 < len(argv) {
			script = argv[i+1]
			break
		}
	}
	if script == "" {
		t.Fatalf("no -c script found: %v", argv)
	}
	// preExec must run after the nft load and immediately before exec "$@".
	nftIdx := strings.Index(script, "NFTEOF")
	preIdx := strings.Index(script, "exec 3<")
	execIdx := strings.Index(script, `exec "$@"`)
	if nftIdx < 0 || preIdx < 0 || execIdx < 0 {
		t.Fatalf("script missing a required part: %q", script)
	}
	if !(nftIdx < preIdx && preIdx < execIdx) {
		t.Errorf("preExec must sit between nft load and exec \"$@\": %q", script)
	}
}

func TestSmokeTestReportsReasonWhenPastaMissing(t *testing.T) {
	// A bogus pasta binary must make smokeTest fail closed with a non-empty reason
	// (so detectHardMode logs it and degrades to advisory) rather than hang or panic.
	reason := smokeTest("/nonexistent/pasta-binary", "/usr/sbin/nft")
	if reason == "" {
		t.Fatal("smokeTest should report a failure reason when pasta cannot run")
	}
	if !strings.Contains(reason, "unreachable") {
		t.Errorf("reason should explain the proxy was unreachable, got %q", reason)
	}
}

func TestProxyEnvCoversCommonSpellings(t *testing.T) {
	env := ProxyEnv("http://127.0.0.1:8080")
	for _, want := range []string{"HTTP_PROXY=", "http_proxy=", "HTTPS_PROXY=", "ALL_PROXY=", "NO_PROXY=localhost"} {
		if !hasPrefixIn(env, want) {
			t.Errorf("ProxyEnv missing %q: %v", want, env)
		}
	}
}

func TestHostPort(t *testing.T) {
	if got := HostPort("127.0.0.1:54321"); got != 54321 {
		t.Errorf("HostPort = %d, want 54321", got)
	}
	if got := HostPort("garbage"); got != 0 {
		t.Errorf("HostPort(garbage) = %d, want 0", got)
	}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func hasPrefixIn(list []string, prefix string) bool {
	for _, x := range list {
		if strings.HasPrefix(x, prefix) {
			return true
		}
	}
	return false
}
