package db

import "testing"

func TestGlobalPathByPlatform(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name         string
		goos         string
		xdgStateHome string
		localAppData string
		home         string
		want         string
	}{
		{name: "Linux XDG", goos: "linux", xdgStateHome: "/state", home: "/home/alice", want: "/state/hydra/db.sqlite3"},
		{name: "Linux fallback", goos: "linux", home: "/home/alice", want: "/home/alice/.local/state/hydra/db.sqlite3"},
		{name: "macOS", goos: "darwin", home: "/Users/alice", want: "/Users/alice/Library/Application Support/Hydra/db.sqlite3"},
		{name: "Windows LocalAppData", goos: "windows", localAppData: `C:\Users\alice\AppData\Local`, home: `C:\Users\alice`, want: `C:\Users\alice\AppData\Local\Hydra\db.sqlite3`},
		{name: "Windows fallback", goos: "windows", home: `C:\Users\alice`, want: `C:\Users\alice\AppData\Local\Hydra\db.sqlite3`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := globalPath(tt.goos, tt.xdgStateHome, tt.localAppData, tt.home)
			if err != nil {
				t.Fatalf("globalPath: %v", err)
			}
			if got != tt.want {
				t.Fatalf("globalPath = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestGlobalPathRejectsUnsupportedPlatform(t *testing.T) {
	t.Parallel()
	if _, err := globalPath("plan9", "", "", "/home/alice"); err == nil {
		t.Fatal("globalPath accepted an unsupported platform")
	}
}
