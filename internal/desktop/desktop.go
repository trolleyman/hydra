// Package desktop contains the thin native shell for the standalone Hydra app.
package desktop

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/daemon"
	"github.com/trolleyman/hydra/internal/desktopcontract"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
)

var desktopLinkID = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// Run opens a native Hydra window connected to rawURL.
func Run(rawURL string) error {
	appURL, err := localServerURL(rawURL)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(run(appURL.String()))
}

// ApplyDeepLink maps the public hydra:// grammar onto a trusted server URL.
// Links contain identifiers only - never arbitrary paths, hosts, or commands.
func ApplyDeepLink(rawServerURL, rawLink string) (string, error) {
	serverURL, err := localServerURL(rawServerURL)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	if rawLink == "" {
		return serverURL.String(), nil
	}
	link, err := url.Parse(rawLink)
	if err != nil || link.Scheme != "hydra" || link.RawQuery != "" || link.Fragment != "" || link.User != nil {
		return "", errtrace.Wrap(fmt.Errorf("invalid Hydra deep link"))
	}
	parts := []string{link.Host}
	parts = append(parts, strings.FieldsFunc(link.Path, func(r rune) bool { return r == '/' })...)
	validID := func(value string) bool { return desktopLinkID.MatchString(value) }
	switch {
	case len(parts) == 1 && parts[0] == "settings":
		serverURL.Path = "/settings"
	case len(parts) == 2 && parts[0] == "project" && validID(parts[1]):
		serverURL.Path = "/project/" + url.PathEscape(parts[1])
	case len(parts) == 4 && parts[0] == "project" && parts[2] == "agent" && validID(parts[1]) && validID(parts[3]):
		serverURL.Path = "/project/" + url.PathEscape(parts[1]) + "/agent/" + url.PathEscape(parts[3])
	case len(parts) == 2 && parts[0] == "focused" && validID(parts[1]):
		serverURL.Path = "/focused/" + url.PathEscape(parts[1])
	default:
		return "", errtrace.Wrap(fmt.Errorf("unknown or unsafe Hydra deep link action"))
	}
	return serverURL.String(), nil
}

// ResolveServer returns the explicitly supplied loopback URL, or ensures the
// daemon for projectRoot is running and reads the web listener it published.
// Exactly one input must be supplied.
func ResolveServer(ctx context.Context, rawURL, projectRoot string) (string, error) {
	if rawURL != "" && projectRoot != "" {
		return "", errtrace.Wrap(fmt.Errorf("url and project cannot be used together"))
	}
	if rawURL != "" {
		appURL, err := localServerURL(rawURL)
		if err != nil {
			return "", errtrace.Wrap(err)
		}
		return appURL.String(), nil
	}
	manager, err := projects.NewManager()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	chatProject, err := manager.EnsureChatProject()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("prepare global desktop service: %w", err))
	}
	selectedRoot := chatProject.Path
	if projectRoot != "" {
		selectedRoot, err = paths.NormalizePath(projectRoot)
		if err != nil {
			return "", errtrace.Wrap(fmt.Errorf("resolve project root: %w", err))
		}
	}
	if err := daemon.EnsureDesktopRunning(ctx, chatProject.Path); err != nil {
		return "", errtrace.Wrap(err)
	}
	client, err := daemon.Connect(ctx, selectedRoot)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	status, err := client.Status(ctx)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("read desktop backend compatibility: %w", err))
	}
	if status.DesktopProtocol == nil || *status.DesktopProtocol != desktopcontract.Protocol {
		got := 0
		if status.DesktopProtocol != nil {
			got = *status.DesktopProtocol
		}
		return "", errtrace.Wrap(fmt.Errorf("desktop backend protocol %d is incompatible with shell protocol %d", got, desktopcontract.Protocol))
	}
	bootstrap, err := client.IssueDesktopBootstrap(ctx)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("authenticate desktop webview: %w", err))
	}

	// The control socket becomes ready just before the daemon publishes its TCP
	// listener. Cover that small startup race without guessing the listener.
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		if webURL, err := daemon.ReadWebURL(chatProject.Path); err == nil {
			appURL, validateErr := localServerURL(webURL)
			if validateErr != nil {
				return "", errtrace.Wrap(fmt.Errorf("daemon published an unsafe web URL: %w", validateErr))
			}
			appURL.Fragment = "desktop-bootstrap=" + url.QueryEscape(bootstrap.Token)
			if client.ProjectID != "" && client.ProjectID != chatProject.ID {
				appURL.Path = "/project/" + url.PathEscape(client.ProjectID)
			}
			return appURL.String(), nil
		} else if !errors.Is(err, os.ErrNotExist) && !errors.Is(err, daemon.ErrStaleWebRecord) {
			return "", errtrace.Wrap(fmt.Errorf("read daemon web listener: %w", err))
		}
		select {
		case <-ctx.Done():
			return "", errtrace.Wrap(fmt.Errorf("wait for daemon web listener: %w", ctx.Err()))
		case <-ticker.C:
		}
	}
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
