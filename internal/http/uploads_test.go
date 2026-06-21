package http

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
)

// newUploadServer builds a Server backed by a real temp project so resolveProjectRoot
// works. Returns the server and the registered project's ID + normalized root.
func newUploadServer(t *testing.T) (*Server, string, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv("HOME", home)

	root := t.TempDir()
	norm, err := paths.NormalizePath(root)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}

	pm, err := projects.NewManager()
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	proj, err := pm.AddProject(norm)
	if err != nil {
		t.Fatalf("add project: %v", err)
	}

	s := &Server{ProjectRoot: norm, ProjectsManager: pm}
	return s, proj.ID, norm
}

func multipartFile(t *testing.T, field, filename string, content []byte) (*bytes.Buffer, string) {
	t.Helper()
	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	fw, err := w.CreateFormFile(field, filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return body, w.FormDataContentType()
}

func TestHandleUpload(t *testing.T) {
	s, projID, root := newUploadServer(t)

	content := []byte("\x89PNG fake image bytes")
	body, ctype := multipartFile(t, "file", "My Screenshot (1).png", content)
	req := httptest.NewRequest(http.MethodPost, "/uploads/projects/"+projID, body)
	req.Header.Set("Content-Type", ctype)
	req.SetPathValue("project_id", projID)
	rr := httptest.NewRecorder()

	s.HandleUpload(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp uploadResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Stored under <root>/.hydra/local/uploads and readable with the original content.
	wantDir := paths.GetUploadsDirFromProjectRoot(root)
	if filepath.Dir(resp.Path) != wantDir {
		t.Errorf("path %q not under %q", resp.Path, wantDir)
	}
	if !strings.HasSuffix(resp.Path, ".png") {
		t.Errorf("expected .png suffix, got %q", resp.Path)
	}
	got, err := os.ReadFile(resp.Path)
	if err != nil {
		t.Fatalf("read stored file: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Errorf("stored content mismatch")
	}
	// Filename must be sanitized (no spaces/parens).
	if strings.ContainsAny(resp.Filename, " ()") {
		t.Errorf("filename not sanitized: %q", resp.Filename)
	}
}

func TestHandleUploadUnknownProject(t *testing.T) {
	s, _, _ := newUploadServer(t)

	body, ctype := multipartFile(t, "file", "x.txt", []byte("hi"))
	req := httptest.NewRequest(http.MethodPost, "/uploads/projects/nope", body)
	req.Header.Set("Content-Type", ctype)
	req.SetPathValue("project_id", "nope")
	rr := httptest.NewRecorder()

	s.HandleUpload(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("expected 404 for unknown project, got %d", rr.Code)
	}
}

func TestHandleUploadRejectsGet(t *testing.T) {
	s, projID, _ := newUploadServer(t)
	req := httptest.NewRequest(http.MethodGet, "/uploads/projects/"+projID, nil)
	req.SetPathValue("project_id", projID)
	rr := httptest.NewRecorder()

	s.HandleUpload(rr, req)

	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405 for GET, got %d", rr.Code)
	}
}

func TestHandleUploadBlob(t *testing.T) {
	s, projID, root := newUploadServer(t)

	// Seed a file in the uploads dir as if it had been uploaded earlier.
	dir := paths.GetUploadsDirFromProjectRoot(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := []byte("\x89PNG fake image bytes")
	name := "1782072241514128486-image1.png"
	if err := os.WriteFile(filepath.Join(dir, name), content, 0o644); err != nil {
		t.Fatal(err)
	}

	serve := func(query string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/uploads/projects/"+projID+"/blob?name="+query, nil)
		req.SetPathValue("project_id", projID)
		rr := httptest.NewRecorder()
		s.HandleUploadBlob(rr, req)
		return rr
	}

	// Happy path: serves the bytes with an image content type.
	rr := serve(name)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	if !bytes.Equal(rr.Body.Bytes(), content) {
		t.Errorf("served content mismatch")
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/") {
		t.Errorf("expected image content type, got %q", ct)
	}

	// Traversal / path-separator names are rejected (404, never escape the dir).
	for _, bad := range []string{"", "..", "../uploads_test.go", "..%2f..%2fetc%2fpasswd", "sub/file.png"} {
		if got := serve(bad).Code; got != http.StatusNotFound {
			t.Errorf("name %q: expected 404, got %d", bad, got)
		}
	}

	// A well-formed but absent name is a 404.
	if got := serve("9999-missing.png").Code; got != http.StatusNotFound {
		t.Errorf("missing file: expected 404, got %d", got)
	}
}

func TestHandleUploadBlobUnknownProject(t *testing.T) {
	s, _, _ := newUploadServer(t)
	req := httptest.NewRequest(http.MethodGet, "/uploads/projects/nope/blob?name=x.png", nil)
	req.SetPathValue("project_id", "nope")
	rr := httptest.NewRecorder()
	s.HandleUploadBlob(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Errorf("expected 404 for unknown project, got %d", rr.Code)
	}
}

func TestPruneUploads(t *testing.T) {
	root := t.TempDir()
	dir := paths.GetUploadsDirFromProjectRoot(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	write := func(name string, age time.Duration) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		mt := time.Now().Add(-age)
		if err := os.Chtimes(p, mt, mt); err != nil {
			t.Fatal(err)
		}
		return p
	}

	old := write("old.png", 40*24*time.Hour)
	fresh := write("fresh.png", 1*time.Hour)
	gitignore := write(".gitignore", 40*24*time.Hour) // must be preserved

	if err := PruneUploads(root, DefaultUploadMaxAge); err != nil {
		t.Fatalf("prune: %v", err)
	}

	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Errorf("expected old upload removed, got err=%v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("expected fresh upload kept, got err=%v", err)
	}
	if _, err := os.Stat(gitignore); err != nil {
		t.Errorf("expected .gitignore kept, got err=%v", err)
	}
}

func TestPruneUploadsMissingDir(t *testing.T) {
	// Nothing ever uploaded: a missing dir is not an error.
	if err := PruneUploads(t.TempDir(), DefaultUploadMaxAge); err != nil {
		t.Errorf("expected nil for missing dir, got %v", err)
	}
}

func TestUniqueUploadName(t *testing.T) {
	cases := map[string]string{
		"photo.png":         ".png",
		"weird name!@#.JPG": ".JPG",
		"noext":             "",
		"../../etc/passwd":  "",
	}
	for in, wantExt := range cases {
		got := uniqueUploadName(in)
		if strings.ContainsAny(got, "/\\") {
			t.Errorf("uniqueUploadName(%q) leaked a path separator: %q", in, got)
		}
		if wantExt != "" && !strings.HasSuffix(got, wantExt) {
			t.Errorf("uniqueUploadName(%q) = %q, want suffix %q", in, got, wantExt)
		}
	}
}
