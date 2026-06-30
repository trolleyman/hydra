package tests

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseJUnitTestsuites(t *testing.T) {
	xml := `<?xml version="1.0"?>
<testsuites tests="4" failures="1" skipped="1">
  <testsuite name="auth" tests="3">
    <testcase name="rotates key" classname="auth/rotation.test.ts" time="0.038"/>
    <testcase name="grace window" classname="auth/rotation.test.ts" time="0.012">
      <failure message="expected kid-2 to be kid-3">at rotation.test.ts:48:24</failure>
    </testcase>
    <testcase name="legacy" classname="auth" time="0">
      <skipped message="pending"/>
    </testcase>
  </testsuite>
  <testsuite name="util">
    <testcase name="adds" classname="util" time="0.001"/>
  </testsuite>
</testsuites>`
	cases, ok := parseJUnit([]byte(xml))
	if !ok {
		t.Fatal("parseJUnit returned not-ok")
	}
	if len(cases) != 4 {
		t.Fatalf("got %d cases, want 4: %+v", len(cases), cases)
	}
	passed, failed, skipped := Summarize(cases)
	if passed != 2 || failed != 1 || skipped != 1 {
		t.Errorf("summary = %d/%d/%d, want 2/1/1", passed, failed, skipped)
	}
	// Failure message should combine attr + body.
	var failCase *TestCase
	for i := range cases {
		if cases[i].Status == CaseFailed {
			failCase = &cases[i]
		}
	}
	if failCase == nil || failCase.Message == "" {
		t.Fatalf("expected a failing case with a message, got %+v", failCase)
	}
	if failCase.DurationMs != 12 {
		t.Errorf("duration = %d ms, want 12", failCase.DurationMs)
	}
	if failCase.Name != "auth/rotation.test.ts › grace window" {
		t.Errorf("name = %q, want classname-prefixed", failCase.Name)
	}
}

func TestParseJUnitBareTestsuite(t *testing.T) {
	xml := `<testsuite name="solo" tests="1"><testcase name="t" time="1"/></testsuite>`
	cases, ok := parseJUnit([]byte(xml))
	if !ok || len(cases) != 1 || cases[0].DurationMs != 1000 {
		t.Fatalf("bare testsuite parse failed: ok=%v cases=%+v", ok, cases)
	}
}

func TestParseHydraJSON(t *testing.T) {
	js := `{"total":3,"passed":1,"failed":1,"skipped":1,"cases":[
		{"name":"a","status":"passed","duration_ms":5},
		{"name":"b","status":"failed","duration_ms":2,"message":"boom"},
		{"name":"c","status":"skipped"}
	]}`
	cases, ok := parseHydraJSON([]byte(js))
	if !ok || len(cases) != 3 {
		t.Fatalf("parseHydraJSON failed: ok=%v cases=%+v", ok, cases)
	}
	passed, failed, skipped := Summarize(cases)
	if passed != 1 || failed != 1 || skipped != 1 {
		t.Errorf("summary = %d/%d/%d, want 1/1/1", passed, failed, skipped)
	}
}

func TestParseDirAggregatesAndIgnoresJunk(t *testing.T) {
	dir := t.TempDir()
	must := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must("a.xml", `<testsuite name="a"><testcase name="t1" time="0"/></testsuite>`)
	must("b.json", `{"cases":[{"name":"t2","status":"failed"}]}`)
	must("notes.txt", "ignore me")
	must("bad.xml", "<not-junit/>")

	cases, format, found, err := ParseDir(dir)
	if err != nil {
		t.Fatalf("ParseDir: %v", err)
	}
	if !found {
		t.Fatal("expected found=true")
	}
	if len(cases) != 2 {
		t.Fatalf("got %d cases, want 2: %+v", len(cases), cases)
	}
	if format != "junit+hydra" {
		t.Errorf("format = %q, want junit+hydra", format)
	}
}

func TestParseDirEmpty(t *testing.T) {
	_, _, found, err := ParseDir(t.TempDir())
	if err != nil || found {
		t.Fatalf("empty dir: found=%v err=%v", found, err)
	}
	_, _, found, err = ParseDir(filepath.Join(t.TempDir(), "does-not-exist"))
	if err != nil || found {
		t.Fatalf("missing dir: found=%v err=%v", found, err)
	}
}
