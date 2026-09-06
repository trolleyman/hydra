package http

import (
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/heads"
	hydratests "github.com/trolleyman/hydra/internal/tests"
)

func TestShouldScheduleAutoRun(t *testing.T) {
	tests := []struct {
		name    string
		mode    config.AutoRunMode
		running bool
		want    bool
	}{
		{name: "default while running", running: true, want: true},
		{name: "always while running", mode: config.AutoRunAlways, running: true, want: true},
		{name: "settled while running", mode: config.AutoRunSettled, running: true, want: false},
		{name: "settled after run", mode: config.AutoRunSettled, want: true},
		{name: "never while running", mode: config.AutoRunNever, running: true, want: false},
		{name: "never after run", mode: config.AutoRunNever, want: false},
		{name: "unknown is safe default", mode: "typo", running: true, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldScheduleAutoRun(tt.mode, tt.running); got != tt.want {
				t.Fatalf("shouldScheduleAutoRun(%q, %t) = %t, want %t", tt.mode, tt.running, got, tt.want)
			}
		})
	}
}

func TestShouldAutoRunOnView(t *testing.T) {
	tests := []struct {
		name string
		mode config.AutoRunMode
		want bool
	}{
		{name: "default", want: true},
		{name: "always", mode: config.AutoRunAlways, want: true},
		{name: "settled", mode: config.AutoRunSettled, want: false},
		{name: "never", mode: config.AutoRunNever, want: false},
		{name: "unknown is safe default", mode: "typo", want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldAutoRunOnView(tt.mode); got != tt.want {
				t.Fatalf("shouldAutoRunOnView(%q) = %t, want %t", tt.mode, got, tt.want)
			}
		})
	}
}

func TestPassiveViewDoesNotStartSettledOrNeverWork(t *testing.T) {
	root, _ := artifactRepo(t, "# base\n", "# head\n")
	testMgr := hydratests.NewManager(root)
	artifactMgr := artifacts.NewManager(root)
	testVersion := hydratests.Version{Ref: "HEAD"}
	artifactVersion := artifacts.Version{Ref: "HEAD"}

	for _, mode := range []config.AutoRunMode{config.AutoRunSettled, config.AutoRunNever} {
		t.Run(string(mode), func(t *testing.T) {
			name := "test-" + string(mode)
			runner := config.TestScript{Name: name, Script: "true", UnsafeHost: true, AutoRun: mode}
			got := (&Server{}).buildTestRunners("project", testMgr, []config.TestScript{runner}, testVersion, "")
			if len(got) != 1 || got[0].Status != api.TestStatusNone {
				t.Fatalf("passive test view = %+v, want one not-run runner", got)
			}
			if _, ok, err := testMgr.Peek(name, testVersion); err != nil || ok {
				t.Fatalf("passive test view created cache: ok=%t err=%v", ok, err)
			}

			artifactName := "artifact-" + string(mode)
			spec := config.ArtifactScript{Name: artifactName, Script: "true", UnsafeHost: true, AutoRun: mode}
			meta, err := artifactMeta(artifactMgr, spec, artifactVersion, false)
			if err != nil || meta.Status != artifacts.StatusReady {
				t.Fatalf("passive artifact view = %+v, err=%v", meta, err)
			}
			if _, ok, err := artifactMgr.Peek(artifactName, artifactVersion); err != nil || ok {
				t.Fatalf("passive artifact view created cache: ok=%t err=%v", ok, err)
			}
		})
	}
}

func TestMergeGateStartsNeverRunner(t *testing.T) {
	root, _ := artifactRepo(t, "# base\n", `[tests.gate]
script = "true"
unsafe_host = true
auto_run = "never"
`)
	branch := "HEAD"
	s := &Server{Tests: hydratests.NewRegistry()}
	mgr := s.Tests.Manager(root)
	events, unsubscribe := mgr.Subscribe()
	defer unsubscribe()
	code, _, blocked := s.testGateVerdict(root, heads.Head{Branch: &branch})
	if !blocked || code != api.MergeConflictErrorErrorTestsErrored {
		t.Fatalf("gate = (%q, blocked=%t), want running test block", code, blocked)
	}
	if _, ok, err := mgr.Peek("gate", hydratests.Version{Ref: branch}); err != nil || !ok {
		t.Fatalf("merge gate did not start never runner: ok=%t err=%v", ok, err)
	}
	select {
	case event := <-events:
		if event.Kind != "settled" {
			t.Fatalf("first test event = %q, want settled", event.Kind)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("merge-triggered never runner did not settle")
	}
}
