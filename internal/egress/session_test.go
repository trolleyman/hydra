package egress

import (
	"runtime"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/sandbox"
)

func TestInboundPortSpec(t *testing.T) {
	for _, tc := range []struct {
		in   int
		want string
	}{
		{0, "none"},
		{-1, "none"},
		{70000, "none"},
		{38913, "127.0.0.1/38913"},
	} {
		if got := InboundPortSpec(tc.in); got != tc.want {
			t.Errorf("InboundPortSpec(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestPastaArgsInboundForward(t *testing.T) {
	// The forwarded port must ride -t bound to host loopback only; everything
	// else stays off.
	args := PastaArgs("/usr/bin/pasta", MapAddr, nil, 38913, "")
	if !argHasValue(args, "-t", "127.0.0.1/38913") {
		t.Errorf("PastaArgs must forward the inbound port via -t: %v", args)
	}
	if !argHasValue(args, "-u", "none") || !argHasValue(args, "-U", "none") {
		t.Errorf("UDP forwarding must stay off: %v", args)
	}
}

func TestHardWrapArgvInboundForward(t *testing.T) {
	hm := HardMode{Available: true, PastaPath: "/usr/bin/pasta", NftPath: "/usr/sbin/nft"}
	bwrap := []string{"/usr/bin/bwrap", "--", "bash"}
	argv := HardWrapArgv(hm, 54321, nil, 38913, bwrap, "", "")
	if !argHasValue(argv, "-t", "127.0.0.1/38913") {
		t.Errorf("HardWrapArgv must thread the inbound forward to pasta -t: %v", argv)
	}
}

// TestStartCommandEgressModes walks the mode ladder for runner commands.
func TestStartCommandEgressModes(t *testing.T) {
	// Off / not enabled: no proxy, policy untouched.
	off := sandbox.NetworkPolicy{Enabled: false, Mode: sandbox.NetOff}
	s := StartCommandEgress("t", sandbox.AgentTypeBash, &off, 0, nil)
	if len(s.Env) != 0 || s.Wrap != nil || s.proxy != nil {
		t.Fatalf("off mode built something: %+v", s)
	}
	s.Close()

	// Unrestricted: open network, no proxy.
	open := sandbox.NetworkPolicy{Enabled: true, Mode: sandbox.NetUnrestricted}
	s = StartCommandEgress("t", sandbox.AgentTypeBash, &open, 0, nil)
	if len(s.Env) != 0 || s.Wrap != nil || !open.Enabled {
		t.Fatalf("unrestricted mode built something: %+v", s)
	}
	s.Close()

	// Advisory: loopback proxy + env, no wrap.
	adv := sandbox.NetworkPolicy{Enabled: true, FilterHosts: true, Mode: sandbox.NetAdvisory}
	s = StartCommandEgress("t", sandbox.AgentTypeBash, &adv, 0, nil)
	if s.proxy == nil || s.Wrap != nil {
		t.Fatalf("advisory mode: proxy=%v wrapSet=%t", s.proxy, s.Wrap != nil)
	}
	found := false
	for _, e := range s.Env {
		if strings.HasPrefix(e, "HTTP_PROXY=http://127.0.0.1:") {
			found = true
		}
	}
	if !found {
		t.Fatalf("advisory env missing loopback proxy: %v", s.Env)
	}
	s.Close()
	if s.proxy != nil {
		t.Fatal("Close did not release the proxy")
	}

	// Hard: Linux wraps in pasta+nft; Darwin records the proxy port for Seatbelt;
	// an unsupported host fails closed (Enabled flipped off).
	hard := sandbox.NetworkPolicy{Enabled: true, FilterHosts: true, Mode: sandbox.NetHard}
	s = StartCommandEgress("t", sandbox.AgentTypeBash, &hard, 38913, nil)
	if hard.Enabled {
		if len(s.Env) == 0 || s.proxy == nil {
			t.Fatalf("active hard mode lacks proxy/env: %+v", s)
		}
		if runtime.GOOS == "linux" && s.Wrap == nil {
			t.Fatal("hard mode with tooling must produce a wrap")
		}
		if runtime.GOOS == "linux" {
			argv := s.Wrap([]string{"/usr/bin/bwrap", "--", "bash"}, "")
			if !argHasValue(argv, "-t", "127.0.0.1/38913") {
				t.Errorf("hard wrap missing inbound forward: %v", argv)
			}
		}
		if runtime.GOOS == "darwin" && (s.Wrap != nil || hard.HardProxyPort == 0) {
			t.Fatalf("Darwin hard mode did not configure Seatbelt: wrap=%v port=%d", s.Wrap != nil, hard.HardProxyPort)
		}
	} else if s.proxy != nil || len(s.Env) != 0 {
		t.Fatalf("failed-closed hard mode retained proxy/env: %+v", s)
	}
	s.Close()
}
