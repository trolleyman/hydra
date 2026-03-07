//go:build hydra_no_frontend

package cli

import "net/http"

// registerFrontend is a no-op when built with hydra_no_frontend.
// The frontend is expected to be served externally (e.g. by the Vite dev server).
func registerFrontend(_ *http.ServeMux) {}
