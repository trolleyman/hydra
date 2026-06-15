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

	// Stored under <root>/.hydra/uploads and readable with the original content.
	wantDir := filepath.Join(paths.GetHydraDirFromProjectRoot(root), "uploads")
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
