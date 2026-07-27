package http

import (
	"context"
	"net/http"
	"testing"
)

func ctxWithHost(host string) context.Context {
	return context.WithValue(context.Background(), requestCtxKey{}, &http.Request{Host: host})
}

// TestPreviewURL pins the protocol-relative "//host:port/" shape: the link must
// follow the page's scheme (http on the LAN, https behind a TLS front) rather
// than a hardcoded http://, which an https page would block as mixed content.
func TestPreviewURL(t *testing.T) {
	cases := []struct {
		name string
		ctx  context.Context
		port int
		want string // "" means nil
	}{
		{"host with port", ctxWithHost("hades:26600"), 26601, "//hades:26601/"},
		{"host without port", ctxWithHost("example.ts.net"), 26601, "//example.ts.net:26601/"},
		{"no request falls back to localhost", context.Background(), 26602, "//localhost:26602/"},
		{"port zero is nil", context.Background(), 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := previewURL(tc.ctx, tc.port)
			if tc.want == "" {
				if got != nil {
					t.Fatalf("previewURL = %q, want nil", *got)
				}
				return
			}
			if got == nil {
				t.Fatalf("previewURL = nil, want %q", tc.want)
			}
			if *got != tc.want {
				t.Fatalf("previewURL = %q, want %q", *got, tc.want)
			}
		})
	}
}
