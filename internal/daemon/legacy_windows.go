//go:build windows

package daemon

import "context"

func RefuseLegacyDaemons(context.Context) error { return nil }
