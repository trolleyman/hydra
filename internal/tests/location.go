package tests

import (
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// locContext carries per-checkout context used to normalize case locations:
// the checkout dir (to relativize absolute report paths) and the Go module
// path from its go.mod (to strip the module prefix off gotestsum package
// classnames). A zero locContext is valid and just skips both normalizations.
type locContext struct {
	checkoutDir string
	goModule    string
	// goFuncs caches, per repo-relative Go package dir, the test-function
	// declarations found in its *_test.go files (see goTestFuncs).
	goFuncs map[string]map[string]goFuncPos
}

func newLocContext(checkoutDir string) *locContext {
	lc := &locContext{checkoutDir: checkoutDir}
	if checkoutDir != "" {
		lc.goModule = readGoModule(filepath.Join(checkoutDir, "go.mod"))
	}
	return lc
}

// readGoModule returns the module path declared in a go.mod, or "".
func readGoModule(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for line := range strings.Lines(string(data)) {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "module "); ok {
			if f := strings.Fields(rest); len(f) > 0 {
				return f[0]
			}
		}
	}
	return ""
}

// location is a classified case location: the filesystem axis (Path) and/or
// the logical axis (Scope). goPkg marks a Path that came from a Go package
// import path (matched against go.mod) - the one situation where the case
// name is a Go test identifier whose "/" separators are subtests.
type location struct {
	Path  string
	Scope []string
	goPkg bool
}

// fileExtRe matches a token's trailing known source-file extension, marking a
// slash-less dot-containing token (format_error.test.ts) as a file name rather
// than a dotted class chain (com.example.FooTest).
var fileExtRe = regexp.MustCompile(`(?i)\.(go|ts|tsx|js|jsx|mjs|cjs|py|rb|java|kt|kts|cs|fs|rs|php|c|cc|cpp|cxx|h|hh|hpp|m|mm|swift|scala|sh|bash|zsh|pl|lua|dart|ex|exs|erl|hs|ml|clj|groovy|sql|vue|svelte|html|css|scss|less|json|ya?ml|toml|xml|md)$`)

// classify routes a JUnit classname (or a streamed marker location token) to
// the structured location axes:
//   - contains a slash, or ends in a known file extension → filesystem → Path
//     (vitest files, eslint files, Go package import paths);
//   - dotted (or $-nested) with no slash → class chain → Scope
//     (com.example.FooTest, tests.test_module.TestClass, FooTest$Nested);
//   - anything else → a single scope segment.
func (lc *locContext) classify(token string) location {
	token = strings.TrimSpace(token)
	switch {
	case token == "":
		return location{}
	case strings.ContainsAny(token, `/\`) || fileExtRe.MatchString(token):
		p, goPkg := lc.normalizePath(token)
		return location{Path: p, goPkg: goPkg}
	case strings.ContainsAny(token, ".$"):
		return location{Scope: splitClassChain(token)}
	default:
		return location{Scope: []string{token}}
	}
}

// normalizePath canonicalizes a filesystem-ish location: forward slashes,
// Go-module prefix stripped (github.com/x/y/internal/foo → internal/foo),
// absolute paths made relative to the checkout, "./" trimmed. The second
// return reports whether the Go module prefix matched.
func (lc *locContext) normalizePath(p string) (string, bool) {
	p = filepath.ToSlash(strings.TrimSpace(p))
	if lc.goModule != "" {
		if p == lc.goModule {
			// Tests in the module root package: repo-relative dir is "".
			return "", true
		}
		if rest, ok := strings.CutPrefix(p, lc.goModule+"/"); ok {
			return rest, true
		}
	}
	if lc.checkoutDir != "" && filepath.IsAbs(filepath.FromSlash(p)) {
		if rel, err := filepath.Rel(lc.checkoutDir, filepath.FromSlash(p)); err == nil && !strings.HasPrefix(rel, "..") {
			return filepath.ToSlash(rel), false
		}
	}
	return strings.TrimPrefix(p, "./"), false
}

// splitClassChain splits a dotted class chain into scope segments, treating a
// nested-class "$" separator (com.example.FooTest$Nested) as a level too.
func splitClassChain(cn string) []string {
	var out []string
	for _, seg := range strings.FieldsFunc(cn, func(r rune) bool { return r == '.' || r == '$' }) {
		if seg = strings.TrimSpace(seg); seg != "" {
			out = append(out, seg)
		}
	}
	return out
}

// Go's testing package only picks up functions named Test*/Benchmark*/Fuzz*/
// Example*; goTestFuncDeclRe finds their declarations in a _test.go source
// line, goTestFuncNameRe cheaply screens a case name for that shape before any
// directory scan.
var (
	goTestFuncDeclRe = regexp.MustCompile(`^func\s+((?:Test|Benchmark|Fuzz|Example)\w*)\s*\(`)
	goTestFuncNameRe = regexp.MustCompile(`^(?:Test|Benchmark|Fuzz|Example)`)
)

// goFuncPos locates one test-function declaration within a package dir.
type goFuncPos struct {
	file string // base name of the declaring *_test.go
	line int    // 1-based declaration line
}

// goTestFuncs indexes the test-function declarations of a repo-relative Go
// package dir, scanning its *_test.go files once (cached per dir). A missing
// or unreadable dir - or one with no test files, i.e. not actually a Go
// package - just yields an empty index.
func (lc *locContext) goTestFuncs(pkgDir string) map[string]goFuncPos {
	if idx, ok := lc.goFuncs[pkgDir]; ok {
		return idx
	}
	idx := map[string]goFuncPos{}
	if lc.goFuncs == nil {
		lc.goFuncs = map[string]map[string]goFuncPos{}
	}
	lc.goFuncs[pkgDir] = idx
	entries, err := os.ReadDir(filepath.Join(lc.checkoutDir, filepath.FromSlash(pkgDir)))
	if err != nil {
		return idx
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(lc.checkoutDir, filepath.FromSlash(pkgDir), e.Name()))
		if err != nil {
			continue
		}
		n := 0
		for line := range strings.Lines(string(data)) {
			n++
			if m := goTestFuncDeclRe.FindStringSubmatch(line); m != nil {
				if _, dup := idx[m[1]]; !dup {
					idx[m[1]] = goFuncPos{file: e.Name(), line: n}
				}
			}
		}
	}
	return idx
}

// resolveGoTestFile upgrades a case whose Path is a Go *package dir* (go test
// reports only the import path - a package spans files) to the *_test.go file
// and line declaring its root test function, so Go cases tree by file like
// every other runner's. goPkg says the path definitely came from a Go package
// import path (JUnit classname matched go.mod); otherwise the path must at
// least be a non-file location. Purely additive: unless the declaration is
// actually found under the checkout, the case is left untouched.
func (lc *locContext) resolveGoTestFile(tc *TestCase, goPkg bool) {
	if lc.checkoutDir == "" || tc.Line != 0 {
		return
	}
	if !goPkg && (tc.Path == "" || fileExtRe.MatchString(tc.Path)) {
		return
	}
	// The root Go test func: the first scope level when subtests were split
	// off, else the leaf name (minus any unsplit "/sub" suffix).
	root := tc.Name
	if len(tc.Scope) > 0 {
		root = tc.Scope[0]
	}
	root, _, _ = strings.Cut(root, "/")
	if !goTestFuncNameRe.MatchString(root) {
		return
	}
	if pos, ok := lc.goTestFuncs(tc.Path)[root]; ok {
		tc.Path = path.Join(tc.Path, pos.file)
		tc.Line = pos.line
	}
}

// dedupeScope drops the leading scope segments that merely re-encode the file
// path: pytest reports classname "tests.test_mod.TestClass" alongside
// file "tests/test_mod.py", so the class chain proper is just [TestClass].
// The path stem is suffix-aligned against the scope prefix, so an extra
// leading source root (src/tests/test_mod.py) still matches.
func dedupeScope(path string, scope []string) []string {
	if path == "" || len(scope) == 0 {
		return scope
	}
	stem := strings.TrimSuffix(path, filepath.Ext(path))
	segs := strings.Split(stem, "/")
	for k := min(len(scope), len(segs)); k > 0; k-- {
		if slices.Equal(scope[:k], segs[len(segs)-k:]) {
			return scope[k:]
		}
	}
	return scope
}
