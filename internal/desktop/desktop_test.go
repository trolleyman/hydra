package desktop

import "testing"

func TestLocalServerURL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{name: "empty", url: "", wantErr: true},
		{name: "IPv4", url: "http://127.0.0.1:49152/project/demo"},
		{name: "IPv6", url: "http://[::1]:49152"},
		{name: "localhost", url: "https://localhost:49152"},
		{name: "localhost trailing dot", url: "http://localhost.:49152"},
		{name: "remote host", url: "https://example.com", wantErr: true},
		{name: "loopback lookalike", url: "https://localhost.example.com", wantErr: true},
		{name: "credentials", url: "http://token@localhost:49152", wantErr: true},
		{name: "file", url: "file:///tmp/index.html", wantErr: true},
		{name: "missing scheme", url: "localhost:49152", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := localServerURL(tt.url)
			if (err != nil) != tt.wantErr {
				t.Fatalf("localServerURL(%q) error = %v, wantErr %v", tt.url, err, tt.wantErr)
			}
		})
	}
}
