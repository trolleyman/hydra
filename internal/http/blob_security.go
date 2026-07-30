package http

import (
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
)

// Content typing, security headers and containment checks shared by every
// endpoint that serves raw file bytes (repository, agent worktree, agent files,
// artifacts, uploads, project icon).
//
// The bytes these endpoints serve are largely AGENT-CONTROLLED - a file the head
// committed to its branch, left in its worktree, or generated as an artifact -
// and they are served from Hydra's OWN origin. That is fine while the browser
// only ever renders them as an <img>/<video> subresource (a script inside an SVG
// never runs there), but the UI also offers to open a blob directly: the
// repository browser's "Raw" link and the artifact viewer's open-in-new-tab both
// navigate to one. A navigation to an agent-authored .svg or .html would then
// execute its script AS the Hydra origin, with the user's session - which is
// full control of the API.
//
// setBlobSecurityHeaders closes that off without changing how anything renders.

// scriptableTypes are the content types a browser will execute script from when
// the response is NAVIGATED to rather than loaded as an image.
var scriptableTypes = []string{"text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml"}

// extContentTypes pins the types http.DetectContentType gets wrong or won't
// commit to for files the UI renders as images or video. SVG is the one that
// matters: Go sniffs it as text/xml (or text/plain), and Go's mime table doesn't
// reliably map it either - which browsers used to paper over by sniffing it back
// to an image inside an <img>. nosniff takes that away, so the type has to be
// right at the source.
//
// The video types are pinned for the same reason from the other direction: Go's
// built-in mime table has no entry for them at all, so the answer would come from
// the host's /etc/mime.types - present on one machine and missing on the next -
// and a .webm served as application/octet-stream under nosniff simply will not
// play.
var extContentTypes = map[string]string{
	".svg":  "image/svg+xml",
	".avif": "image/avif",
	".ico":  "image/x-icon",
	".bmp":  "image/bmp",
	".webm": "video/webm",
	".mp4":  "video/mp4",
	".m4v":  "video/x-m4v",
	".mov":  "video/quicktime",
	".ogv":  "video/ogg",
}

// setBlobSecurityHeaders locks down a raw-bytes response of a known type.
// nosniff pins the declared type so a .png full of HTML can't be re-interpreted,
// and a script-capable type additionally gets a sandbox CSP: navigating to it
// lands in an opaque origin that can load nothing and reach nothing, so its
// script cannot touch Hydra's origin or session. The CSP is deliberately NOT set
// for other types - it would also disable the browser's PDF viewer, and an
// <img>/<video> subresource is not a script context in the first place, so it
// buys nothing there.
func setBlobSecurityHeaders(w http.ResponseWriter, contentType string) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	ct := strings.ToLower(contentType)
	for _, t := range scriptableTypes {
		if strings.HasPrefix(ct, t) {
			w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
			return
		}
	}
}

// blobContentType picks the Content-Type for raw file bytes already in memory:
// the extension when it names a type worth trusting over sniffing, else what the
// content sniffs as.
func blobContentType(name string, data []byte) string {
	if ct, ok := extContentTypes[strings.ToLower(filepath.Ext(name))]; ok {
		return ct
	}
	return http.DetectContentType(data)
}

// setBlobFileHeaders pins the Content-Type of a file about to be handed to
// http.ServeContent and applies the matching security headers. ServeContent
// leaves an already-set Content-Type alone, so deciding it here means nothing is
// ever served as a type that wasn't checked - including the awkward case of a
// file with no (or an unknown) extension, which is sniffed from its first bytes
// rather than left for ServeContent to sniff behind our back. The reader is
// rewound afterwards, so the caller can pass it straight on.
func setBlobFileHeaders(w http.ResponseWriter, f io.ReadSeeker, name string) {
	ext := strings.ToLower(filepath.Ext(name))
	ct, ok := extContentTypes[ext]
	if !ok {
		ct = mime.TypeByExtension(ext)
	}
	if ct == "" {
		ct = sniffContentType(f)
	}
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	setBlobSecurityHeaders(w, ct)
}

// sniffContentType detects a content type from the first bytes of f, leaving f
// rewound to the start. Returns "" if the file can't be read or rewound (in
// which case the caller simply declares no type and ServeContent sniffs).
func sniffContentType(f io.ReadSeeker) string {
	var buf [512]byte
	n, err := io.ReadFull(f, buf[:])
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return ""
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return ""
	}
	return http.DetectContentType(buf[:n])
}

// containedIn reports whether full is root or sits underneath it, comparing the
// symlink-resolved forms of both. Resolving means a symlink planted inside the
// root that points outside it is rejected rather than followed, and a root that
// is itself reached through a symlink (macOS /tmp -> /private/tmp) still matches.
func containedIn(root, full string) bool {
	r, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	f, err := filepath.EvalSymlinks(full)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(r, f)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
