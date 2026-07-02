package egress

import (
	"io"
	"net/http"
	"net/url"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
)

// newClient returns an HTTP client that routes everything through the proxy.
func newClient(t *testing.T, p *Proxy) *http.Client {
	t.Helper()
	proxyURL, err := url.Parse("http://" + p.Addr())
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
}

func TestProxyAllowsListedHostForwardsHTTP(t *testing.T) {
	// Upstream the agent is allowed to reach.
	upstream := newTestServer(t, "ok")
	defer upstream.Close()
	host := mustHost(t, upstream.URL)

	p, err := Start("h1", []string{host}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	resp, err := newClient(t, p).Get(upstream.URL)
	if err != nil {
		t.Fatalf("allowed host should be reachable: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != "ok" {
		t.Fatalf("unexpected response: %d %q", resp.StatusCode, body)
	}
}

func TestProxyBlocksUnlistedHost(t *testing.T) {
	upstream := newTestServer(t, "secret")
	defer upstream.Close()

	// Allow-list deliberately excludes the upstream host.
	p, err := Start("h1", []string{"only.example.com"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	resp, err := newClient(t, p).Get(upstream.URL)
	if err != nil {
		t.Fatalf("request itself should reach the proxy: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("blocked host should get 403, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) == "secret" {
		t.Fatal("blocked host returned upstream content — egress not filtered")
	}
}

func TestProxyWildcard(t *testing.T) {
	upstream := newTestServer(t, "ok")
	defer upstream.Close()
	host := mustHost(t, upstream.URL) // 127.0.0.1

	// A wildcard that does not cover the loopback host must still block it.
	p, err := Start("h1", []string{"*.example.com"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	resp, err := newClient(t, p).Get(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("non-matching wildcard should block %s, got %d", host, resp.StatusCode)
	}
}

func TestProxyApproveGrantsUnlistedHost(t *testing.T) {
	upstream := newTestServer(t, "ok")
	defer upstream.Close()
	host := mustHost(t, upstream.URL)

	var calls int32
	approve := func(h string, _ <-chan struct{}) bool {
		atomic.AddInt32(&calls, 1)
		return h == host // approve exactly the upstream host
	}
	// Empty allow-list: the host is unknown and must be approved to be reached.
	p, err := Start("h1", nil, nil, approve)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	resp, err := newClient(t, p).Get(upstream.URL)
	if err != nil {
		t.Fatalf("approved host should be reachable: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(body) != "ok" {
		t.Fatalf("unexpected response after approval: %d %q", resp.StatusCode, body)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("approver call count = %d, want 1", got)
	}

	// A second request to the now-approved host must NOT prompt again (the grant
	// is remembered for the session).
	resp2, err := newClient(t, p).Get(upstream.URL)
	if err != nil {
		t.Fatalf("re-request to approved host failed: %v", err)
	}
	resp2.Body.Close()
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("approver re-prompted a granted host (calls = %d, want 1)", got)
	}
}

func TestProxyApproveDeniesUnlistedHost(t *testing.T) {
	upstream := newTestServer(t, "secret")
	defer upstream.Close()

	approve := func(string, <-chan struct{}) bool { return false }
	p, err := Start("h1", nil, nil, approve)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	resp, err := newClient(t, p).Get(upstream.URL)
	if err != nil {
		t.Fatalf("request itself should reach the proxy: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("denied approval should get 403, got %d", resp.StatusCode)
	}
}

func TestProxyApproveBlockListNeverPrompts(t *testing.T) {
	upstream := newTestServer(t, "ok")
	defer upstream.Close()
	host := mustHost(t, upstream.URL)

	var calls int32
	approve := func(string, <-chan struct{}) bool { atomic.AddInt32(&calls, 1); return true }
	// Host is explicitly block-listed: block wins, the approver is never consulted.
	p, err := Start("h1", nil, []string{host}, approve)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	resp, err := newClient(t, p).Get(upstream.URL)
	if err != nil {
		t.Fatalf("request itself should reach the proxy: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("block-listed host should get 403, got %d", resp.StatusCode)
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Fatalf("approver consulted for a block-listed host (calls = %d, want 0)", got)
	}
}

func TestProxyApproveCollapsesConcurrentSameHost(t *testing.T) {
	upstream := newTestServer(t, "ok")
	defer upstream.Close()

	var calls int32
	release := make(chan struct{})
	approve := func(string, <-chan struct{}) bool {
		atomic.AddInt32(&calls, 1)
		<-release // hold every in-flight prompt open until released
		return true
	}
	p, err := Start("h1", nil, nil, approve)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	const n = 5
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := newClient(t, p).Get(upstream.URL)
			if err == nil {
				resp.Body.Close()
			}
		}()
	}
	// Give the goroutines time to reach the proxy and coalesce on the one prompt.
	for atomic.LoadInt32(&calls) == 0 {
		runtime.Gosched()
	}
	close(release)
	wg.Wait()
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("concurrent connections to the same host prompted %d times, want 1", got)
	}
}

func TestProxyBlockListOverridesAllow(t *testing.T) {
	upstream := newTestServer(t, "ok")
	defer upstream.Close()
	host := mustHost(t, upstream.URL)

	// Host is on the allow-list but also on the block-list — block wins.
	p, err := Start("h1", []string{host}, []string{host}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()

	resp, err := newClient(t, p).Get(upstream.URL)
	if err != nil {
		t.Fatalf("request itself should reach the proxy: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("block-list should override allow-list, got %d", resp.StatusCode)
	}
}
