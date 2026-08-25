package forge

import (
	"braces.dev/errtrace"
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestSubmitGraphiteTracksParentThenSubmits(t *testing.T) {
	var calls [][]string
	run := func(_ context.Context, dir, name string, args ...string) (string, error) {
		calls = append(calls, append([]string{dir, name}, args...))
		if len(calls) == 1 {
			return "", errtrace.Wrap(errors.New("not tracked"))
		}
		return "", nil
	}
	if err := submitGraphite(context.Background(), "/wt", "hydra/child", "hydra/parent", true, run); err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"/wt", "gt", "--no-interactive", "branch", "info", "hydra/child"},
		{"/wt", "gt", "--no-interactive", "branch", "track", "hydra/child", "--parent", "hydra/parent"},
		{"/wt", "gt", "--no-interactive", "submit", "--no-edit", "--branch", "hydra/child", "--draft"},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v, want %#v", calls, want)
	}
}

func TestSubmitGraphiteSkipsTrackForTrackedBranch(t *testing.T) {
	var calls [][]string
	run := func(_ context.Context, _, name string, args ...string) (string, error) {
		calls = append(calls, append([]string{name}, args...))
		return "", nil
	}
	if err := submitGraphite(context.Background(), "/wt", "hydra/one", "main", false, run); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || calls[1][2] != "submit" {
		t.Fatalf("expected info then submit, got %#v", calls)
	}
}
