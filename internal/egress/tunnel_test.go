package egress

import (
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// Go enables SO_KEEPALIVE on dialed and accepted TCP conns by default (15s idle),
// and internal/egress relies on it: a CONNECT tunnel has no idle timeout - a
// streaming model response is idle for long stretches, so a read deadline would
// kill live traffic - which leaves keepalive as the only thing that unblocks the
// splice(2) when a peer vanishes WITHOUT a FIN. Without it both goroutines and
// their sockets stay pinned until the daemon exits.
//
// So this test guards an assumption about the runtime rather than our own code.
// Setting keepalive explicitly in handleConnect was written, tested, and reverted
// once this test showed the option was already on - the explicit version only
// lengthened the probe interval. If a future Go stops doing this, that regression
// surfaces here instead of as slowly accumulating tunnels in production.
func TestGoEnablesKeepAliveByDefault(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	raw, err := c.(*net.TCPConn).SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var opt int
	var optErr error
	if err := raw.Control(func(fd uintptr) {
		opt, optErr = unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_KEEPALIVE)
	}); err != nil {
		t.Fatal(err)
	}
	if optErr != nil {
		t.Fatal(optErr)
	}
	if opt == 0 {
		t.Error("SO_KEEPALIVE on a dialed conn = 0; egress tunnels now need to set it explicitly " +
			"(see handleConnect) or a vanished peer will pin its goroutines forever")
	}
}

// There was no end-to-end CONNECT test before; this one covers the tunnel path
// itself - an allow-listed host must carry TLS in both directions through it.
func TestProxyTunnelsConnectBothWays(t *testing.T) {
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_, _ = w.Write(append([]byte("echo:"), body...))
	}))
	defer upstream.Close()
	host := mustHost(t, upstream.URL)

	p, err := Start("tunnel", 0, []string{host}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	proxyURL, err := url.Parse("http://" + p.Addr())
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{
		Proxy:           http.ProxyURL(proxyURL),
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}}
	resp, err := client.Post(upstream.URL, "text/plain", strings.NewReader("hello"))
	if err != nil {
		t.Fatalf("CONNECT tunnel failed: %v", err)
	}
	defer resp.Body.Close()
	got, _ := io.ReadAll(resp.Body)
	if string(got) != "echo:hello" {
		t.Errorf("through the tunnel = %q, want %q", got, "echo:hello")
	}
}
