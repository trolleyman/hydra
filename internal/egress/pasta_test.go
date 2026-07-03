package egress

import (
	"strings"
	"testing"
)

func TestHardWrapArgvShape(t *testing.T) {
	hm := HardMode{Available: true, PastaPath: "/usr/bin/pasta", NftPath: "/usr/sbin/nft"}
	bwrap := []string{"/usr/bin/bwrap", "--ro-bind", "/", "/", "--", "claude"}
	argv := HardWrapArgv(hm, 54321, nil, bwrap, "")

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
	argv := HardWrapArgv(hm, 54321, nil, bwrap, pre)

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

func TestPastaArgsMapAddrIsOnLink(t *testing.T) {
	// Regression: a link-local map address (169.254.x) is NOT on-link when it's
	// only reachable via a gateway, so the netns connect fails with "Network is
	// unreachable". The guest must therefore be pinned to a synthetic subnet whose
	// gateway IS the map address, and that address must not be link-local.
	if strings.HasPrefix(MapAddr, "169.254.") {
		t.Fatalf("MapAddr %q is link-local — unroutable via a gateway in the netns", MapAddr)
	}
	args := PastaArgs("/usr/bin/pasta", MapAddr, nil)
	// mapAddr must be handed to pasta as the gateway, so pasta installs a default
	// route via it and it becomes on-link for the guest.
	if !argHasValue(args, "-g", MapAddr) {
		t.Errorf("PastaArgs must set the gateway to MapAddr %q: %v", MapAddr, args)
	}
	// The guest needs a concrete address in the same subnet as the gateway.
	if !argHasValue(args, "-a", GuestAddr) {
		t.Errorf("PastaArgs must assign the guest address %q: %v", GuestAddr, args)
	}
	// Sanity: guest and gateway share the same /24 so the gateway is on-link.
	gp := func(a string) string { return a[:strings.LastIndex(a, ".")] }
	if gp(GuestAddr) != gp(MapAddr) {
		t.Errorf("GuestAddr %q and MapAddr %q must be in the same subnet", GuestAddr, MapAddr)
	}
	// Regression: -a/-n/-g only pick the values - pasta applies them to a spawned
	// netns solely under --config-net. Without it (and with DHCP/RA/NDP disabled)
	// the interface stays unconfigured and every connect dies with ENETUNREACH.
	if !contains(args, "--config-net") {
		t.Errorf("PastaArgs must pass --config-net or the netns is never configured: %v", args)
	}
}

func TestLoopbackPortSpec(t *testing.T) {
	// Empty/invalid-only lists must keep outbound splicing fully off ("none"),
	// and bad values must be dropped rather than handed to pasta, which would
	// reject its whole argv and kill the head at launch.
	for _, tc := range []struct {
		in   []int
		want string
	}{
		{nil, "none"},
		{[]int{}, "none"},
		{[]int{0, -1, 70000}, "none"},
		{[]int{5037}, "5037"},
		{[]int{5037, 5037, 8080}, "5037,8080"},
		{[]int{5037, 0, 8080}, "5037,8080"},
	} {
		if got := LoopbackPortSpec(tc.in); got != tc.want {
			t.Errorf("LoopbackPortSpec(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestPastaArgsLoopbackPorts(t *testing.T) {
	// Without an allow-list, outbound TCP splicing must be off entirely.
	if args := PastaArgs("/usr/bin/pasta", MapAddr, nil); !argHasValue(args, "-T", "none") {
		t.Errorf("PastaArgs without ports must pass -T none: %v", args)
	}
	// With an allow-list, only those ports are spliced (-T), and everything else
	// stays off - inbound (-t/-u) and outbound UDP (-U) in particular.
	args := PastaArgs("/usr/bin/pasta", MapAddr, []int{5037})
	if !argHasValue(args, "-T", "5037") {
		t.Errorf("PastaArgs must splice the allow-listed loopback port via -T: %v", args)
	}
	for _, flag := range []string{"-t", "-u", "-U"} {
		if !argHasValue(args, flag, "none") {
			t.Errorf("PastaArgs must keep %s none even with loopback ports allowed: %v", flag, args)
		}
	}
}

func TestHardWrapArgvLoopbackPorts(t *testing.T) {
	// The port allow-list must reach pasta's argv through the wrap used at launch.
	hm := HardMode{Available: true, PastaPath: "/usr/bin/pasta", NftPath: "/usr/sbin/nft"}
	bwrap := []string{"/usr/bin/bwrap", "--", "claude"}
	argv := HardWrapArgv(hm, 54321, []int{5037, 5555}, bwrap, "")
	if !argHasValue(argv, "-T", "5037,5555") {
		t.Errorf("HardWrapArgv must forward the loopback-port allow-list to pasta -T: %v", argv)
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

func TestStripPastaNoise(t *testing.T) {
	// The AVX2 fallback line is benign chatter pasta emits when the pasta.avx2
	// sibling is absent; it must not lead (or appear in) a failure detail.
	in := "Can't run AVX2 build, using non-AVX2 version: No such file or directory\n" +
		"bash: connect: Network is unreachable"
	got := stripPastaNoise(in)
	if strings.Contains(got, "AVX2") {
		t.Errorf("AVX2 noise not stripped: %q", got)
	}
	if !strings.Contains(got, "Network is unreachable") {
		t.Errorf("real error dropped: %q", got)
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

// argHasValue reports whether flag appears in args immediately followed by value.
func argHasValue(args []string, flag, value string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == value {
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
