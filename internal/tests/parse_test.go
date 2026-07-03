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
	cases, ok := parseJUnit([]byte(xml), &locContext{})
	if !ok {
		t.Fatal("parseJUnit returned not-ok")
	}
	if len(cases) != 4 {
		t.Fatalf("got %d cases, want 4: %+v", len(cases), cases)
	}
	passed, failed, skipped, warnings := Summarize(cases)
	if passed != 2 || failed != 1 || skipped != 1 || warnings != 0 {
		t.Errorf("summary = %d/%d/%d/%d, want 2/1/1/0", passed, failed, skipped, warnings)
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
	// The classname is no longer pre-joined into the name: a file-looking
	// classname becomes the structured Path, the bare name stays the leaf.
	if failCase.Name != "grace window" || failCase.Path != "auth/rotation.test.ts" || len(failCase.Scope) != 0 {
		t.Errorf("location = name %q path %q scope %v, want (grace window, auth/rotation.test.ts, [])", failCase.Name, failCase.Path, failCase.Scope)
	}
	// A bare non-dotted classname ("auth") becomes a single scope segment.
	var skippedCase *TestCase
	for i := range cases {
		if cases[i].Status == CaseSkipped {
			skippedCase = &cases[i]
		}
	}
	if skippedCase == nil || skippedCase.Name != "legacy" || skippedCase.Path != "" || len(skippedCase.Scope) != 1 || skippedCase.Scope[0] != "auth" {
		t.Errorf("skipped location = %+v, want name legacy, scope [auth]", skippedCase)
	}
}

func TestParseJUnitBareTestsuite(t *testing.T) {
	xml := `<testsuite name="solo" tests="1"><testcase name="t" time="1"/></testsuite>`
	cases, ok := parseJUnit([]byte(xml), &locContext{})
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
	passed, failed, skipped, warnings := Summarize(cases)
	if passed != 1 || failed != 1 || skipped != 1 || warnings != 0 {
		t.Errorf("summary = %d/%d/%d/%d, want 1/1/1/0", passed, failed, skipped, warnings)
	}
}

func TestParseHydraJSONWarning(t *testing.T) {
	js := `{"cases":[
		{"name":"clean.ts","status":"passed"},
		{"name":"lint: no-unused-vars","status":"warning","message":"'x' is defined but never used"},
		{"name":"lint: deprecation","status":"warn"}
	]}`
	cases, ok := parseHydraJSON([]byte(js))
	if !ok || len(cases) != 3 {
		t.Fatalf("parseHydraJSON failed: ok=%v cases=%+v", ok, cases)
	}
	passed, failed, skipped, warnings := Summarize(cases)
	if passed != 1 || failed != 0 || skipped != 0 || warnings != 2 {
		t.Errorf("summary = %d/%d/%d/%d, want 1/0/0/2", passed, failed, skipped, warnings)
	}
}

// A JUnit case whose failures are all type="warning" (e.g. eslint's junit
// formatter for warning-severity messages) is a non-failing warning, not red.
func TestParseJUnitWarningType(t *testing.T) {
	xml := `<testsuite name="eslint" tests="2">
	  <testcase name="a.ts" time="0">
	    <failure message="prefer-const" type="warning">a.ts:1:1</failure>
	  </testcase>
	  <testcase name="b.ts" time="0">
	    <failure message="no-undef" type="error">b.ts:2:2</failure>
	  </testcase>
	</testsuite>`
	cases, ok := parseJUnit([]byte(xml), &locContext{})
	if !ok {
		t.Fatal("parseJUnit returned not-ok")
	}
	passed, failed, skipped, warnings := Summarize(cases)
	if passed != 0 || failed != 1 || skipped != 0 || warnings != 1 {
		t.Errorf("summary = %d/%d/%d/%d, want 0/1/0/1", passed, failed, skipped, warnings)
	}
	// The warning case keeps its message.
	for _, c := range cases {
		if c.Status == CaseWarning && c.Message == "" {
			t.Errorf("warning case %q lost its message", c.Name)
		}
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

	cases, format, found, err := ParseDir(dir, "")
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

// A case whose file location isn't present in the checkout is flagged
// PathMissing (informational — it doesn't change the verdict). Existing files,
// and non-file paths (a bare Go package dir), are left alone.
func TestParseDirFlagsMissingFile(t *testing.T) {
	outDir := t.TempDir()
	checkout := t.TempDir()
	if err := os.MkdirAll(filepath.Join(checkout, "web", "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, "web", "src", "exists.ts"), []byte("export {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	report := `{"cases":[
		{"name":"a","status":"passed","path":"web/src/exists.ts"},
		{"name":"b","status":"passed","path":"web/src/gone.ts"},
		{"name":"c","status":"passed","path":"internal/nope"}
	]}`
	if err := os.WriteFile(filepath.Join(outDir, "r.json"), []byte(report), 0o644); err != nil {
		t.Fatal(err)
	}
	cases, _, found, err := ParseDir(outDir, checkout)
	if err != nil || !found {
		t.Fatalf("ParseDir: found=%v err=%v", found, err)
	}
	byName := map[string]TestCase{}
	for _, c := range cases {
		byName[c.Name] = c
	}
	if byName["a"].PathMissing {
		t.Errorf("existing file flagged missing: %+v", byName["a"])
	}
	if !byName["b"].PathMissing {
		t.Errorf("missing file NOT flagged: %+v", byName["b"])
	}
	if byName["c"].PathMissing {
		t.Errorf("non-file path (Go package dir) should not be flagged: %+v", byName["c"])
	}

	// With no checkout dir there's nothing to check against — nothing is flagged.
	cases, _, _, err = ParseDir(outDir, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if c.PathMissing {
			t.Errorf("no checkout: case %q wrongly flagged missing", c.Name)
		}
	}
}

// gotestsum: the classname is a Go package import path — the module prefix is
// stripped to a repo-relative dir, and subtest names split into scope.
func TestParseJUnitGoPackage(t *testing.T) {
	xml := `<testsuites>
	  <testsuite name="github.com/trolleyman/hydra/internal/artifacts">
	    <testcase name="TestGenerateAndCache" classname="github.com/trolleyman/hydra/internal/artifacts" time="0.5"/>
	    <testcase name="TestOverlay/mounts/readonly" classname="github.com/trolleyman/hydra/internal/artifacts" time="0.1"/>
	    <testcase name="TestRoot" classname="github.com/trolleyman/hydra" time="0"/>
	  </testsuite>
	</testsuites>`
	lc := &locContext{goModule: "github.com/trolleyman/hydra"}
	cases, ok := parseJUnit([]byte(xml), lc)
	if !ok || len(cases) != 3 {
		t.Fatalf("parse failed: ok=%v cases=%+v", ok, cases)
	}
	if cases[0].Path != "internal/artifacts" || cases[0].Name != "TestGenerateAndCache" || len(cases[0].Scope) != 0 {
		t.Errorf("plain case = %+v, want path internal/artifacts, no scope", cases[0])
	}
	if cases[1].Path != "internal/artifacts" || cases[1].Name != "readonly" ||
		!equalStrs(cases[1].Scope, []string{"TestOverlay", "mounts"}) {
		t.Errorf("subtest case = %+v, want scope [TestOverlay mounts] name readonly", cases[1])
	}
	// Go subtest parents are functions: every scope level tagged "function".
	if !equalStrs(cases[1].ScopeKinds, []string{"function", "function"}) {
		t.Errorf("subtest scope kinds = %v, want [function function]", cases[1].ScopeKinds)
	}
	if len(cases[0].ScopeKinds) != 0 {
		t.Errorf("scopeless case kinds = %v, want none", cases[0].ScopeKinds)
	}
	if cases[2].Path != "" || cases[2].Name != "TestRoot" {
		t.Errorf("root-package case = %+v, want empty path", cases[2])
	}
}

// With a real checkout on disk, a Go package-dir case resolves further to the
// *_test.go file (and line) declaring its root test function.
func TestParseJUnitGoPackageResolvesFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "go.mod"), "module github.com/trolleyman/hydra\n\ngo 1.22\n")
	writeFile(t, filepath.Join(dir, "internal", "artifacts", "manager_test.go"),
		"package artifacts\n\nimport \"testing\"\n\nfunc TestGenerateAndCache(t *testing.T) {}\n\nfunc TestOverlay(t *testing.T) {}\n")
	writeFile(t, filepath.Join(dir, "internal", "artifacts", "helper_test.go"),
		"package artifacts\n\nfunc helper() {}\n")

	xml := `<testsuites>
	  <testsuite name="github.com/trolleyman/hydra/internal/artifacts">
	    <testcase name="TestGenerateAndCache" classname="github.com/trolleyman/hydra/internal/artifacts" time="0.5"/>
	    <testcase name="TestOverlay/mounts/readonly" classname="github.com/trolleyman/hydra/internal/artifacts" time="0.1"/>
	    <testcase name="TestMissing" classname="github.com/trolleyman/hydra/internal/artifacts" time="0"/>
	  </testsuite>
	</testsuites>`
	cases, ok := parseJUnit([]byte(xml), newLocContext(dir))
	if !ok || len(cases) != 3 {
		t.Fatalf("parse failed: ok=%v cases=%+v", ok, cases)
	}
	if cases[0].Path != "internal/artifacts/manager_test.go" || cases[0].Line != 5 {
		t.Errorf("plain case = %+v, want path internal/artifacts/manager_test.go line 5", cases[0])
	}
	// Subtests resolve via their root func (scope[0]).
	if cases[1].Path != "internal/artifacts/manager_test.go" || cases[1].Line != 7 || cases[1].Name != "readonly" {
		t.Errorf("subtest case = %+v, want path internal/artifacts/manager_test.go line 7", cases[1])
	}
	// An undeclared func (build-tagged out, generated names) keeps the package dir.
	if cases[2].Path != "internal/artifacts" || cases[2].Line != 0 {
		t.Errorf("unresolved case = %+v, want package-dir path", cases[2])
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// pytest: dotted classname + native file/line attrs. The file attr wins as the
// path, the classname's path-echoing prefix is deduped away leaving the class
// chain, and the 0-based line is bumped to 1-based.
func TestParseJUnitPytest(t *testing.T) {
	xml := `<testsuites>
	  <testsuite name="pytest" tests="2">
	    <testcase classname="tests.test_auth.TestRotation" name="test_grace_window" file="tests/test_auth.py" line="41" time="0.01"/>
	    <testcase classname="tests.test_auth" name="test_module_level" file="tests/test_auth.py" line="7" time="0.01"/>
	  </testsuite>
	</testsuites>`
	cases, ok := parseJUnit([]byte(xml), &locContext{})
	if !ok || len(cases) != 2 {
		t.Fatalf("parse failed: ok=%v cases=%+v", ok, cases)
	}
	if cases[0].Path != "tests/test_auth.py" || !equalStrs(cases[0].Scope, []string{"TestRotation"}) ||
		cases[0].Name != "test_grace_window" || cases[0].Line != 42 {
		t.Errorf("class case = %+v, want path tests/test_auth.py scope [TestRotation] line 42", cases[0])
	}
	if !equalStrs(cases[1].Scope, nil) || cases[1].Line != 8 {
		t.Errorf("module-level case = %+v, want empty scope line 8", cases[1])
	}
}

// Java-style: dotted classname, no file attr anywhere → scope-only, with a
// nested-class $ separator treated as another level.
func TestParseJUnitDottedClassname(t *testing.T) {
	xml := `<testsuite name="surefire">
	  <testcase classname="com.example.auth.FooTest$Nested" name="rotatesKey" time="0.2"/>
	</testsuite>`
	cases, ok := parseJUnit([]byte(xml), &locContext{})
	if !ok || len(cases) != 1 {
		t.Fatalf("parse failed: ok=%v cases=%+v", ok, cases)
	}
	c := cases[0]
	if c.Path != "" || !equalStrs(c.Scope, []string{"com", "example", "auth", "FooTest", "Nested"}) || c.Name != "rotatesKey" {
		t.Errorf("case = %+v, want scope [com example auth FooTest Nested]", c)
	}
	// Lowercase package segments are module-kind; the PascalCase class and its
	// nested class classify as "class" so the UI can mark them with a class glyph.
	if !equalStrs(c.ScopeKinds, []string{"module", "module", "module", "class", "class"}) {
		t.Errorf("dotted-class scope kinds = %v, want [module module module class class]", c.ScopeKinds)
	}
}

// vitest: file classname + " > "-joined describe chain in the name → the
// chain splits into scope levels under the file.
func TestParseJUnitVitestDescribeChain(t *testing.T) {
	xml := `<testsuite name="vitest">
	  <testcase classname="src/api/format_error.test.ts" name="formatError > with cause > includes chain" time="0.004"/>
	</testsuite>`
	cases, ok := parseJUnit([]byte(xml), &locContext{})
	if !ok || len(cases) != 1 {
		t.Fatalf("parse failed: ok=%v cases=%+v", ok, cases)
	}
	c := cases[0]
	if c.Path != "src/api/format_error.test.ts" || !equalStrs(c.Scope, []string{"formatError", "with cause"}) || c.Name != "includes chain" {
		t.Errorf("case = %+v, want scope [formatError, with cause] name 'includes chain'", c)
	}
	// A vitest describe chain is module-kind at every level.
	if !equalStrs(c.ScopeKinds, []string{"module", "module"}) {
		t.Errorf("describe scope kinds = %v, want [module module]", c.ScopeKinds)
	}
}

// Hydra-native JSON passes the structured location fields straight through.
func TestParseHydraJSONLocation(t *testing.T) {
	js := `{"cases":[{"name":"no-console","status":"warning","path":"web/src/x.ts","line":12,"col":5,"scope":["rules"]}]}`
	cases, ok := parseHydraJSON([]byte(js))
	if !ok || len(cases) != 1 {
		t.Fatalf("parse failed: ok=%v cases=%+v", ok, cases)
	}
	c := cases[0]
	if c.Path != "web/src/x.ts" || c.Line != 12 || c.Col != 5 || !equalStrs(c.Scope, []string{"rules"}) {
		t.Errorf("case = %+v, want location passed through", c)
	}
}

func TestClassify(t *testing.T) {
	lc := &locContext{goModule: "github.com/trolleyman/hydra"}
	for _, tt := range []struct {
		in    string
		path  string
		scope []string
	}{
		{"src/api/x.test.ts", "src/api/x.test.ts", nil},
		{"format_error.test.ts", "format_error.test.ts", nil}, // bare file: extension, not class chain
		{"github.com/trolleyman/hydra/internal/db", "internal/db", nil},
		{"com.example.FooTest", "", []string{"com", "example", "FooTest"}},
		{"FooTest$Nested", "", []string{"FooTest", "Nested"}},
		{"auth", "", []string{"auth"}},
		{"", "", nil},
	} {
		loc := lc.classify(tt.in)
		if loc.Path != tt.path || !equalStrs(loc.Scope, tt.scope) {
			t.Errorf("classify(%q) = (%q, %v), want (%q, %v)", tt.in, loc.Path, loc.Scope, tt.path, tt.scope)
		}
	}
}

func equalStrs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestParseDirEmpty(t *testing.T) {
	_, _, found, err := ParseDir(t.TempDir(), "")
	if err != nil || found {
		t.Fatalf("empty dir: found=%v err=%v", found, err)
	}
	_, _, found, err = ParseDir(filepath.Join(t.TempDir(), "does-not-exist"), "")
	if err != nil || found {
		t.Fatalf("missing dir: found=%v err=%v", found, err)
	}
}
