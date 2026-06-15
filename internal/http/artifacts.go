package http

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
)

// GetAgentArtifacts runs (or returns cached) artifact scripts for both sides of
// the requested comparison and reports, per script, which files differ.
func (s *Server) GetAgentArtifacts(ctx context.Context, request api.GetAgentArtifactsRequestObject) (api.GetAgentArtifactsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.Id)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if head == nil {
		return api.GetAgentArtifacts404JSONResponse{
			Code:    404,
			Error:   api.ErrorResponseErrorNotFound,
			Details: "agent not found",
		}, nil
	}

	mgr := s.Artifacts
	empty := api.ArtifactsResponse{Scripts: []api.ArtifactSet{}}

	liveCfg, err := config.Load(projectRoot)
	if err != nil || mgr == nil || head.Branch == nil {
		return api.GetAgentArtifacts200JSONResponse(empty), nil
	}

	// Left version: a committed ref. When no explicit base ref is requested we
	// baseline against the *merge-base* (fork point) of the base branch and the
	// head branch — NOT the base branch tip. This mirrors the triple-dot diff used
	// for code (see GetAgentDiff) so artifacts reflect only the branch's own
	// changes. Otherwise commits landed on the base branch after the fork would
	// regenerate the "before" artifact from newer state, producing spurious
	// before/after differences (e.g. a screenshot's clock) unrelated to the work.
	leftRef := head.BaseBranch
	if request.Params.BaseRef != nil && *request.Params.BaseRef != "" {
		leftRef = *request.Params.BaseRef
	} else if mb, err := git.GetMergeBase(projectRoot, head.BaseBranch, *head.Branch); err == nil && mb != "" {
		leftRef = mb
	}
	left := artifacts.Version{Ref: leftRef}

	// Right version: uncommitted working tree, an explicit ref, or the branch tip.
	var right artifacts.Version
	includeUncommitted := request.Params.IncludeUncommitted != nil && *request.Params.IncludeUncommitted
	switch {
	case includeUncommitted && head.Worktree != nil:
		right = artifacts.Version{WorktreeDir: *head.Worktree}
	case request.Params.HeadRef != nil && *request.Params.HeadRef != "":
		right = artifacts.Version{Ref: *request.Params.HeadRef}
	default:
		right = artifacts.Version{Ref: *head.Branch}
	}

	// Resolve the artifact scripts independently for each side: the [[artifacts]]
	// section of .hydra/config.toml is loaded as it existed *at each version*, not
	// once from the live config. So if the branch adds, removes, renames, or edits
	// a script, the "before" side runs the merge-base's definitions and the "after"
	// side runs the branch's. The two are then matched up by script name below.
	leftByName, err := artifactSpecsByName(projectRoot, left, liveCfg)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	rightByName, err := artifactSpecsByName(projectRoot, right, liveCfg)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if len(leftByName) == 0 && len(rightByName) == 0 {
		return api.GetAgentArtifacts200JSONResponse(empty), nil
	}

	// Union of names present on either side, sorted for stable output.
	nameSet := map[string]struct{}{}
	for n := range leftByName {
		nameSet[n] = struct{}{}
	}
	for n := range rightByName {
		nameSet[n] = struct{}{}
	}
	names := make([]string, 0, len(nameSet))
	for n := range nameSet {
		names = append(names, n)
	}
	sort.Strings(names)

	sets := make([]api.ArtifactSet, 0, len(names))
	for _, name := range names {
		var leftSpec, rightSpec *config.ArtifactScript
		if spec, ok := leftByName[name]; ok {
			leftSpec = &spec
		}
		if spec, ok := rightByName[name]; ok {
			rightSpec = &spec
		}
		sets = append(sets, s.buildArtifactSet(request.ProjectId, name, leftSpec, rightSpec, mgr, left, right))
	}

	return api.GetAgentArtifacts200JSONResponse(api.ArtifactsResponse{Scripts: sets}), nil
}

// artifactSpecsByName loads the artifact scripts that apply to one side of the
// comparison and indexes them by name. It reads .hydra/config.toml as it existed
// at that version — the worktree's own file for an uncommitted working tree, or
// the file at the committed ref otherwise — so a branch's [[artifacts]] edits are
// reflected on the side that introduced them. Scripts with an empty name or
// command are dropped, and on a duplicate name the first definition wins.
//
// Security: a version's config is attacker-controllable (a branch can edit
// .hydra/config.toml), and unsafe_host runs a command unconfined on the host, so
// a version is never allowed to grant itself host access. unsafe_host is honored
// only when the trusted live config (config.Load of the project root, what a human
// controls on the main branch) authorizes that exact name+command; otherwise the
// command is forced back into the sandbox. Sandboxed commands need no such gate —
// the sandbox is the boundary and already runs the checkout's untrusted code.
func artifactSpecsByName(projectRoot string, v artifacts.Version, liveCfg config.Config) (map[string]config.ArtifactScript, error) {
	var content []byte
	if v.WorktreeDir != "" {
		// Read the worktree's own config so uncommitted [[artifacts]] edits apply.
		data, err := os.ReadFile(config.GetProjectConfigPath(v.WorktreeDir))
		if err != nil && !os.IsNotExist(err) {
			return nil, errtrace.Wrap(err)
		}
		content = data // nil when absent → inherits the user config's artifacts
	} else {
		data, err := git.ShowFile(projectRoot, v.Ref, ".hydra/config.toml")
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		content = data
	}

	specs, err := config.ArtifactsAtProjectTOML(content)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	trustedHost := trustedHostCommands(liveCfg)
	byName := make(map[string]config.ArtifactScript, len(specs))
	for _, spec := range specs {
		if spec.Name == "" || spec.Command == "" {
			continue
		}
		if _, dup := byName[spec.Name]; dup {
			continue
		}
		if spec.UnsafeHost && !trustedHost[hostKey(spec.Name, spec.Command)] {
			// A version-sourced command not authorized on the host by the trusted
			// config must run confined, regardless of what the version claims.
			spec.UnsafeHost = false
		}
		byName[spec.Name] = spec
	}
	return byName, nil
}

// trustedHostCommands returns the set of name+command pairs that the live config
// explicitly authorizes to run unconfined on the host (unsafe_host = true).
func trustedHostCommands(cfg config.Config) map[string]bool {
	trusted := map[string]bool{}
	for _, s := range cfg.Artifacts {
		if s.UnsafeHost && s.Name != "" && s.Command != "" {
			trusted[hostKey(s.Name, s.Command)] = true
		}
	}
	return trusted
}

// hostKey keys the trusted-host set by name and command. The NUL separator can't
// appear in either field, so distinct (name, command) pairs never collide.
func hostKey(name, command string) string { return name + "\x00" + command }

// buildArtifactSet generates/loads both sides for one script (matched by name)
// and folds them into the API representation. Either side's spec may be nil when
// the script is defined on only one version (added or removed on the branch); a
// nil side contributes no files, so its counterparts surface as added/removed.
func (s *Server) buildArtifactSet(projectID, name string, leftSpec, rightSpec *config.ArtifactScript, mgr *artifacts.Manager, left, right artifacts.Version) api.ArtifactSet {
	set := api.ArtifactSet{Name: name, Files: []api.ArtifactFile{}}

	var leftMeta, rightMeta artifacts.Meta
	var lerr, rerr error
	if leftSpec != nil {
		leftMeta, lerr = mgr.Get(*leftSpec, left)
	} else {
		leftMeta = artifacts.Meta{Status: artifacts.StatusReady}
	}
	if rightSpec != nil {
		rightMeta, rerr = mgr.Get(*rightSpec, right)
	} else {
		rightMeta = artifacts.Meta{Status: artifacts.StatusReady}
	}
	if lerr != nil || rerr != nil {
		set.Status = api.Error
		msg := joinErrs(lerr, rerr)
		set.Error = &msg
		return set
	}

	// Overall status: generating dominates, then error, else ready.
	switch {
	case leftMeta.Status == artifacts.StatusGenerating || rightMeta.Status == artifacts.StatusGenerating:
		set.Status = api.Generating
		return set
	case leftMeta.Status == artifacts.StatusError || rightMeta.Status == artifacts.StatusError:
		set.Status = api.Error
		msg := joinMetaErrs(leftMeta, rightMeta)
		set.Error = &msg
		return set
	default:
		set.Status = api.Ready
	}

	deltas := mgr.Compare(leftMeta, rightMeta)
	set.Changed = artifacts.AnyChanged(deltas)
	for _, d := range deltas {
		f := api.ArtifactFile{Name: d.Name, ChangeType: api.ArtifactFileChangeType(d.Change)}
		if d.InLeft {
			f.LeftUrl = ptr(blobURL(projectID, name, leftMeta.Key, d.Name))
		}
		if d.InRight {
			f.RightUrl = ptr(blobURL(projectID, name, rightMeta.Key, d.Name))
		}
		set.Files = append(set.Files, f)
	}
	return set
}

// blobURL builds the (same-origin) URL the frontend fetches an artifact file from.
func blobURL(projectID, script, key, file string) string {
	q := url.Values{}
	q.Set("script", script)
	q.Set("key", key)
	q.Set("file", file)
	return fmt.Sprintf("/artifacts/projects/%s/blob?%s", url.PathEscape(projectID), q.Encode())
}

// HandleArtifactBlob serves a single generated artifact file. It is registered
// outside the OpenAPI mux because it returns raw image bytes, not JSON.
func (s *Server) HandleArtifactBlob(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project_id")
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil || s.Artifacts == nil {
		http.NotFound(w, r)
		return
	}
	// The daemon owns a single project; only serve blobs for it.
	if projectRoot != s.ProjectRoot {
		http.NotFound(w, r)
		return
	}

	q := r.URL.Query()
	path, contentType, err := s.Artifacts.BlobPath(q.Get("script"), q.Get("key"), q.Get("file"))
	if err != nil {
		http.Error(w, "invalid artifact request", http.StatusBadRequest)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=300")
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}

func joinErrs(a, b error) string {
	switch {
	case a != nil && b != nil:
		return a.Error() + "; " + b.Error()
	case a != nil:
		return a.Error()
	case b != nil:
		return b.Error()
	}
	return ""
}

func joinMetaErrs(a, b artifacts.Meta) string {
	var parts []string
	if a.Status == artifacts.StatusError && a.Error != "" {
		parts = append(parts, "left: "+a.Error)
	}
	if b.Status == artifacts.StatusError && b.Error != "" {
		parts = append(parts, "right: "+b.Error)
	}
	if len(parts) == 0 {
		return "generation failed"
	}
	out := parts[0]
	for _, p := range parts[1:] {
		out += "; " + p
	}
	return out
}
