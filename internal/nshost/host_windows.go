//go:build windows

package nshost

import (
	"fmt"
	"os"
	"time"

	"braces.dev/errtrace"
)

// errUnsupported is returned by every entry point: the namespace host relies on
// bubblewrap + unix-socket fd passing, neither of which exists on Windows.
var errUnsupported = fmt.Errorf("nshost: namespace host is not supported on Windows")

func Serve(socketPath string) error { return errtrace.Wrap(errUnsupported) }

func WaitForSocket(socketPath string, timeout time.Duration) error {
	return errtrace.Wrap(errUnsupported)
}

type Client struct{}

func Dial(socket string) *Client { return &Client{} }

func (c *Client) Spawn(req SpawnRequest) (*Spawned, error) {
	return nil, errtrace.Wrap(errUnsupported)
}

// Spawned is a non-functional placeholder on Windows.
type Spawned struct{}

func (s *Spawned) Read(b []byte) (int, error)     { return 0, errtrace.Wrap(errUnsupported) }
func (s *Spawned) Write(b []byte) (int, error)    { return 0, errtrace.Wrap(errUnsupported) }
func (s *Spawned) Close() error                   { return errtrace.Wrap(errUnsupported) }
func (s *Spawned) Resize(rows, cols uint16) error { return errtrace.Wrap(errUnsupported) }
func (s *Spawned) Wait() error                    { return errtrace.Wrap(errUnsupported) }
func (s *Spawned) Pid() int                       { return 0 }
func (s *Spawned) Signal(sig os.Signal) error     { return errtrace.Wrap(errUnsupported) }
