//go:build windows

package cli

import (
	"errors"

	"github.com/gorilla/websocket"
)

// attachWS is not supported on Windows yet (ConPTY attach lands with the
// Windows sandbox backend).
func attachWS(conn *websocket.Conn) error {
	if conn != nil {
		_ = conn.Close()
	}
	return errors.New("hydra: interactive attach is not yet supported on Windows")
}
