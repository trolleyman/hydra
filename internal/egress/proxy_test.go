package egress

import (
	"io"
	"net/http"
	"net/url"
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

	p, err := Start("h1", []string{host}, nil)
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
	p, err := Start("h1", []string{"only.example.com"}, nil)
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
	p, err := Start("h1", []string{"*.example.com"}, nil)
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

func TestProxyBlockListOverridesAllow(t *testing.T) {
	upstream := newTestServer(t, "ok")
	defer upstream.Close()
	host := mustHost(t, upstream.URL)

	// Host is on the allow-list but also on the block-list — block wins.
	p, err := Start("h1", []string{host}, []string{host})
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
