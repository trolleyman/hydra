//go:build unix

package heads

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/statepath"
)

func TestStopShellCommandWithChildren(t *testing.T) {
	for _, command := range []string{
		`printf 'blah\n' | bash -c 'echo $$ > child.pid; read -r input; printf ready; sleep 30'`,
		`sleep 30 & echo $! > child.pid; printf ready; exit 0`,
	} {
		t.Run(command, func(t *testing.T) {
			root := t.TempDir()
			t.Setenv("HOME", root)
			t.Setenv("XDG_CONFIG_HOME", root)
			t.Setenv(statepath.Environment, filepath.Join(root, "state"))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			// A failing regression must not leave the fixture's long-lived child.
			t.Cleanup(func() {
				data, _ := os.ReadFile(filepath.Join(root, "child.pid"))
				if pid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil {
					p, _ := os.FindProcess(pid)
					_ = p.Kill()
				}
			})
			ready := make(chan struct{})
			var once sync.Once
			done := make(chan struct{})
			var result ShellCommandResult
			var runErr error
			go func() {
				defer close(done)
				result, runErr = RunShellCommand(ctx, root, root, "stop-command", sandbox.AgentTypeCodex, ShellCommandPolicy{Local: true}, command, func(chunk string) {
					if strings.Contains(chunk, "ready") {
						once.Do(func() { close(ready) })
					}
				})
			}()
			select {
			case <-ready:
			case <-done:
				t.Fatalf("command ended before readiness: %+v, %v", result, runErr)
			case <-time.After(10 * time.Second):
				t.Fatal("command never produced output")
			}
			cancel()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("Stop hung waiting for a child to close the output pipe")
			}
			if runErr != nil || !result.Stopped || result.TimedOut || !strings.Contains(result.Output, "ready") {
				t.Fatalf("stopped command lost its status or output: %+v, %v", result, runErr)
			}
		})
	}
}
