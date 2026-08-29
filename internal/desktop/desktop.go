// Package desktop contains the thin native shell for the standalone Hydra app.
package desktop

import (
	"braces.dev/errtrace"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// Run opens a native Hydra window connected to rawURL.
func Run(rawURL string) error {
	appURL, err := localServerURL(rawURL)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(run(appURL.String()))
}

func localServerURL(rawURL string) (*url.URL, error) {
	if rawURL == "" {
		return nil, errtrace.Wrap(fmt.Errorf("server URL is required"))
	}
	appURL, err := url.Parse(rawURL)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("parse server URL: %w", err))
	}
	if appURL.Scheme != "http" && appURL.Scheme != "https" {
		return nil, errtrace.Wrap(fmt.Errorf("server URL must use http or https"))
	}
	if appURL.User != nil {
		return nil, errtrace.Wrap(fmt.Errorf("server URL must not contain credentials"))
	}
	if appURL.Host == "" {
		return nil, errtrace.Wrap(fmt.Errorf("server URL must include a host"))
	}

	host := strings.TrimSuffix(appURL.Hostname(), ".")
	if !strings.EqualFold(host, "localhost") {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return nil, errtrace.Wrap(fmt.Errorf("server URL must use a loopback host"))
		}
	}
	return appURL, nil
}
