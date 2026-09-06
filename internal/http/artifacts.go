package http

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
)

// GetAgentArtifacts returns artifact scripts for both sides of the requested
// comparison and reports, per script, which files differ. A passive read starts
// only "always" scripts; Refresh explicitly starts the named script in every
// mode.
func (s *Server) GetAgentArtifacts(ctx context.Context, request api.GetAgentArtifactsRequestObject) (api.GetAgentArtifactsResponseObject, error) {
	projectRoot, err := s.resolveProjectRoot(request.ProjectId)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	head, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, request.AgentId)
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

	plan, err := s.resolveArtifactPlan(projectRoot, head, request.Params)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if plan == nil {
		return api.GetAgentArtifacts200JSONResponse(api.ArtifactsResponse{Scripts: []api.ArtifactSet{}}), nil
	}

	// A refresh request names one script whose cached result the user wants
	// discarded and regenerated - chiefly to retry a cached failure. Drop the
	// cache entry before generating so the Get calls below kick off a fresh run
	// instead of returning the stale (errored) meta. refresh_side narrows that to
	// just the before/after side, leaving the other side's cache untouched.
	if request.Params.Refresh != nil {
		side := ""
		if request.Params.RefreshSide != nil {
			side = string(*request.Params.RefreshSide)
		}
		plan.invalidateSide(*request.Params.Refresh, side)
	}

	force := ""
	if request.Params.Refresh != nil {
		force = *request.Params.Refresh
	}
	return api.GetAgentArtifacts200JSONResponse(api.ArtifactsResponse{Scripts: plan.buildSets(s, request.ProjectId, force)}), nil
}

// artifactPlan captures everything needed to (re)build the artifact sets for one
// comparison: the manager, the two resolved versions, and the per-side scripts
// indexed by name. Shared by the HTTP poll handler and the WS streaming handler.
type artifactPlan struct {
	mgr          *artifacts.Manager
	left, right  artifacts.Version
	names        []string
	leftByName   map[string]config.ArtifactScript
	rightByName  map[string]config.ArtifactScript
	agentRunning bool
}

// artifactMeta returns cached/in-flight state in every mode, but a passive view
// starts missing work only for "always" or when the user explicitly refreshes.
// A deferred miss is represented as an empty ready side, which keeps the card
// available (and its Refresh control usable) without inventing a generation.
func artifactMeta(mgr *artifacts.Manager, spec config.ArtifactScript, v artifacts.Version, force bool) (artifacts.Meta, error) {
	if force || shouldAutoRunOnView(spec.AutoRun) {
		return errtrace.Wrap2(mgr.Get(spec, v))
	}
	meta, ok, err := mgr.Peek(spec.Name, v)
	if err != nil {
		return artifacts.Meta{}, errtrace.Wrap(err)
	}
	if ok {
		return meta, nil
	}
	return artifacts.Meta{Script: spec.Name, Status: artifacts.StatusReady}, nil
}

// resolveArtifactPlan resolves the comparison's two versions and the artifact
// scripts defined on each side. It returns (nil, nil) when there is nothing to
// compare (no artifacts manager, the head has no branch, or no scripts on either
// side) so callers can short-circuit to an empty response.
func (s *Server) resolveArtifactPlan(projectRoot string, head *heads.Head, params api.GetAgentArtifactsParams) (*artifactPlan, error) {
	if s.Artifacts == nil {
		return nil, nil
	}
	liveCfg, err := config.Load(projectRoot)
	if err != nil {
		return nil, nil //nolint:nilerr // a missing/unreadable config means "no artifacts"
	}
	mgr := s.Artifacts.Manager(projectRoot)

	// Left version: a committed ref. When no explicit base ref is requested we
	// baseline against the *merge-base* (fork point) of the base branch and the
	// head branch - NOT the base branch tip. This mirrors the triple-dot diff used
	// for code (see GetAgentDiff) so artifacts reflect only the branch's own
	// changes. Otherwise commits landed on the base branch after the fork would
	// regenerate the "before" artifact from newer state, producing spurious
	// before/after differences (e.g. a screenshot's clock) unrelated to the work.
	leftRef := head.BaseBranch
	if head.UsesProjectDirectory() {
		leftRef = workspaceComparisonBase(projectRoot, head)
	}
	if params.BaseRef != nil && *params.BaseRef != "" {
		leftRef = *params.BaseRef
	} else if head.Branch != nil {
		if mb, err := git.GetMergeBase(projectRoot, head.BaseBranch, *head.Branch); err == nil && mb != "" {
			leftRef = mb
		}
	}
	if leftRef == "" {
		return nil, nil
	}
	left := artifacts.Version{Ref: leftRef}

	// Right version: uncommitted working tree, an explicit ref, or the branch tip.
	var right artifacts.Version
	includeUncommitted := params.IncludeUncommitted != nil && *params.IncludeUncommitted
	switch {
	case includeUncommitted && head.WorkingDir() != "":
		right = artifacts.Version{WorktreeDir: head.WorkingDir()}
	case params.HeadRef != nil && *params.HeadRef != "":
		right = artifacts.Version{Ref: *params.HeadRef}
	case head.Branch != nil:
		right = artifacts.Version{Ref: *head.Branch}
	default:
		right = artifacts.Version{Ref: "HEAD"}
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
		return nil, nil
	}

	// Union of names present on either side, sorted for stable output. Scripts the
	// live (human-controlled) config explicitly disables are dropped, mirroring how
	// unsafe_host defers to the live config rather than a diffed ref's claims.
	disabled := disabledArtifacts(liveCfg)
	nameSet := map[string]struct{}{}
	for n := range leftByName {
		if !disabled[n] {
			nameSet[n] = struct{}{}
		}
	}
	for n := range rightByName {
		if !disabled[n] {
			nameSet[n] = struct{}{}
		}
	}
	names := make([]string, 0, len(nameSet))
	for n := range nameSet {
		names = append(names, n)
	}
	sort.Strings(names)

	return &artifactPlan{mgr: mgr, left: left, right: right, names: names, leftByName: leftByName, rightByName: rightByName, agentRunning: headActivelyRunning(head)}, nil
}

// specsFor returns the (possibly nil) left and right specs for one script name.
func (p *artifactPlan) specsFor(name string) (left, right *config.ArtifactScript) {
	if spec, ok := p.leftByName[name]; ok {
		left = &spec
	}
	if spec, ok := p.rightByName[name]; ok {
		right = &spec
	}
	return left, right
}

// staleableDirs returns the cache dirs of this plan's right (head) side when that
// side is the uncommitted working tree - the only versions that go stale as the
// head keeps editing. A commit/merge-base side is immutable and shared across
// views, so it is deliberately excluded and never preempted. The prefetcher uses
// these to cancel a head's superseded background renders when it moves on.
func (p *artifactPlan) staleableDirs() []string {
	if p.right.WorktreeDir == "" {
		return nil
	}
	dirs := make([]string, 0, len(p.names))
	for _, name := range p.names {
		if _, rightSpec := p.specsFor(name); rightSpec != nil {
			if d, err := p.mgr.EntryDir(name, p.right); err == nil {
				dirs = append(dirs, d)
			}
		}
	}
	return dirs
}

// buildSet generates/loads one script (by name) and folds it into the API shape.
func (p *artifactPlan) buildSet(s *Server, projectID, name string, force bool) api.ArtifactSet {
	leftSpec, rightSpec := p.specsFor(name)
	return s.buildArtifactSet(projectID, name, leftSpec, rightSpec, p.mgr, p.left, p.right, force)
}

// metasFor returns both sides' current metas for one script, kicking off (or
// reading the in-flight snapshot of) each side's generation. A nil spec (script
// absent on that version) yields an empty ready meta, so its counterpart's files
// read as added/removed. The artifacts WS calls this per file event: Get is cheap
// on a cache hit or an in-flight entry (it just returns a snapshot, including the
// files streamed so far), so per-file diffing never re-runs a generation.
func (p *artifactPlan) metasFor(name string) (left, right artifacts.Meta) {
	leftSpec, rightSpec := p.specsFor(name)
	if leftSpec != nil {
		left, _ = artifactMeta(p.mgr, *leftSpec, p.left, false)
	} else {
		left = artifacts.Meta{Status: artifacts.StatusReady}
	}
	if rightSpec != nil {
		right, _ = artifactMeta(p.mgr, *rightSpec, p.right, false)
	} else {
		right = artifacts.Meta{Status: artifacts.StatusReady}
	}
	return left, right
}

// buildSets builds every script's set, in stable name order.
func (p *artifactPlan) buildSets(s *Server, projectID, forceName string) []api.ArtifactSet {
	sets := make([]api.ArtifactSet, 0, len(p.names))
	for _, name := range p.names {
		sets = append(sets, p.buildSet(s, projectID, name, name == forceName))
	}
	return sets
}

// invalidate drops both sides' cache for one script so the next build regenerates
// it (a no-op if the name isn't part of this comparison).
func (p *artifactPlan) invalidate(name string) {
	p.invalidateSide(name, "")
}

// invalidateSide drops one (or both) side's cache for one script so the next build
// regenerates it, leaving the other side's cached result intact. side is "left"
// (before) or "right" (after); any other value (e.g. "") invalidates both. A no-op
// if the name isn't part of this comparison.
func (p *artifactPlan) invalidateSide(name, side string) {
	found := false
	for _, n := range p.names {
		if n == name {
			found = true
			break
		}
	}
	if !found {
		return
	}
	if side != "right" {
		_ = p.mgr.Invalidate(name, p.left)
	}
	if side != "left" {
		_ = p.mgr.Invalidate(name, p.right)
	}
}

// artifactSpecsByName loads the artifact scripts that apply to one side of the
// comparison and indexes them by name. It reads .hydra/config.toml as it existed
// at that version - the worktree's own file for an uncommitted working tree, or
// the file at the committed ref otherwise - so a branch's [[artifacts]] edits are
// reflected on the side that introduced them. Scripts with an empty name or
// command are dropped, and on a duplicate name the first definition wins.
//
// Security: a version's config is attacker-controllable (a branch can edit
// .hydra/config.toml), and unsafe_host runs a command unconfined on the host, so
// a version is never allowed to grant itself host access. unsafe_host is honored
// only when the trusted live config (config.Load of the project root, what a human
// controls on the main branch) authorizes that exact name+command; otherwise the
// command is forced back into the sandbox. Sandboxed commands need no such gate -
// the sandbox is the boundary and already runs the checkout's untrusted code.
func artifactSpecsByName(projectRoot string, v artifacts.Version, liveCfg config.Config) (map[string]config.ArtifactScript, error) {
	content, err := configTOMLAtVersion(projectRoot, v.WorktreeDir, v.Ref)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	specs, err := config.ArtifactsAtProjectTOML(content)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	trustedHost := trustedHostCommands(liveCfg)
	byName := make(map[string]config.ArtifactScript, len(specs))
	for _, spec := range specs {
		if spec.Name == "" || spec.Script == "" {
			continue
		}
		if _, dup := byName[spec.Name]; dup {
			continue
		}
		if spec.UnsafeHost && !trustedHost[hostKey(spec.Name, spec.Script, hostKindArtifact)] {
			// A version-sourced command not authorized on the host by the trusted
			// config must run confined, regardless of what the version claims.
			spec.UnsafeHost = false
		}
		byName[spec.Name] = spec
	}
	return byName, nil
}

// configTOMLAtVersion reads .hydra/config.toml as it existed at one side of a
// comparison: the worktree's own file for an uncommitted working tree (so
// uncommitted config edits apply), or the file at the committed ref otherwise.
// A missing worktree file is nil content, which inherits the user config.
func configTOMLAtVersion(projectRoot, worktreeDir, ref string) ([]byte, error) {
	if worktreeDir != "" {
		data, err := os.ReadFile(config.GetProjectConfigPath(worktreeDir))
		if err != nil && !os.IsNotExist(err) {
			return nil, errtrace.Wrap(err)
		}
		return data, nil
	}
	data, err := git.ShowFile(projectRoot, ref, ".hydra/config.toml")
	return data, errtrace.Wrap(err)
}

// disabledArtifacts returns the set of script names the live config marks
// enabled = false. The live config is human-controlled, so it - not a diffed
// ref's config - decides whether a script runs.
func disabledArtifacts(cfg config.Config) map[string]bool {
	disabled := map[string]bool{}
	for _, s := range cfg.Artifacts {
		if s.Name != "" && !s.IsEnabled() {
			disabled[s.Name] = true
		}
	}
	return disabled
}

// trustedHostCommands returns the set of name+command pairs that the live config
// explicitly authorizes to run unconfined on the host (unsafe_host = true).
func trustedHostCommands(cfg config.Config) map[string]bool {
	trusted := map[string]bool{}
	for _, s := range cfg.Artifacts {
		if s.UnsafeHost && s.Name != "" && s.Script != "" {
			trusted[hostKey(s.Name, s.Script, hostKindArtifact)] = true
		}
	}
	return trusted
}

// hostKindArtifact / hostKindPreview are the script KINDS hostKey scopes trust
// to. They are not read from config - artifacts and previews are separate config
// sections now, so the kind is fixed at each call site. hostKindArtifact keeps
// the old empty-string spelling so a trust key computed before the split still
// matches.
const (
	hostKindArtifact = ""
	hostKindPreview  = config.ArtifactTypeServer
)

// hostKey keys the trusted-host set by name, command AND kind. The NUL separator
// can't appear in the fields, so distinct tuples never collide. The kind is
// included so trust granted to a one-shot media generator can never be spent on
// a persistent host-resident preview (or vice versa) by reusing the authorized
// name+command under the other section. "media" is accepted as an alias for the
// artifact kind: config no longer carries a type at all (decodeConfig clears it),
// but an explicit "media" must key identically if one ever reaches here.
func hostKey(name, command, kind string) string {
	if kind == "media" {
		kind = hostKindArtifact
	}
	return name + "\x00" + command + "\x00" + kind
}

// buildArtifactSet generates/loads both sides for one script (matched by name)
// and folds them into the API representation. Either side's spec may be nil when
// the script is defined on only one version (added or removed on the branch); a
// nil side contributes no files, so its counterparts surface as added/removed.
func (s *Server) buildArtifactSet(projectID, name string, leftSpec, rightSpec *config.ArtifactScript, mgr *artifacts.Manager, left, right artifacts.Version, force bool) api.ArtifactSet {
	set := api.ArtifactSet{Name: name, Files: []api.ArtifactFile{}}

	var leftMeta, rightMeta artifacts.Meta
	var lerr, rerr error
	if leftSpec != nil {
		leftMeta, lerr = artifactMeta(mgr, *leftSpec, left, force)
	} else {
		leftMeta = artifacts.Meta{Status: artifacts.StatusReady}
	}
	if rightSpec != nil {
		rightMeta, rerr = artifactMeta(mgr, *rightSpec, right, force)
	} else {
		rightMeta = artifacts.Meta{Status: artifacts.StatusReady}
	}
	if lerr != nil || rerr != nil {
		set.Status = api.ArtifactSetStatusError
		msg := joinErrs(lerr, rerr)
		set.Error = &msg
		return set
	}

	// Per-side fields, so the panel can show two side-by-side logs, a "left ·
	// right" progress header, and reopen each log after generation. While a side
	// generates it carries a live progress line + log; once it settles (ready or
	// error) it carries a URL to its persisted log instead. A nil spec means the
	// side is absent on that version (script added/removed) and contributes none.
	set.LeftProgress = nonEmptyPtr(leftMeta.Progress)
	set.RightProgress = nonEmptyPtr(rightMeta.Progress)
	// Queue position, so the card can say "waiting behind other work" instead of
	// showing a generation that has not started as though it were running.
	if leftMeta.Queued > 0 {
		set.LeftQueued = ptr(leftMeta.Queued)
	}
	if rightMeta.Queued > 0 {
		set.RightQueued = ptr(rightMeta.Queued)
	}
	set.LeftLog = ptr(toAPILog(leftMeta.Log))
	set.RightLog = ptr(toAPILog(rightMeta.Log))
	if t := earliestStart(leftMeta.StartedAt, rightMeta.StartedAt); t > 0 {
		set.StartedAt = &t
	}
	if leftSpec != nil && leftMeta.Status != artifacts.StatusGenerating && mgr.HasLog(name, leftMeta.Key) {
		set.LeftLogUrl = ptr(logURL(projectID, name, leftMeta.Key))
	}
	if rightSpec != nil && rightMeta.Status != artifacts.StatusGenerating && mgr.HasLog(name, rightMeta.Key) {
		set.RightLogUrl = ptr(logURL(projectID, name, rightMeta.Key))
	}

	leftErrored := leftMeta.Status == artifacts.StatusError
	rightErrored := rightMeta.Status == artifacts.StatusError

	// Surface a single side's error as soon as it fails - BEFORE the status switch
	// below, so a partial failure is reported even while the other side is still
	// generating. Otherwise a side that failed mid-set carries its persisted log
	// URL (set above) but no error, and the live log column mistakes its drained
	// live log + URL for a clean finish and paints it the green "succeeded" border.
	// When BOTH sides fail the whole set is "error" and set.Error carries the
	// combined message instead (the per-side fields stay null then, per the API
	// contract - see left_error/right_error docs).
	bothFailed := leftErrored && rightErrored
	if leftErrored && !bothFailed {
		set.LeftError = nonEmptyPtr(leftMeta.Error)
	}
	if rightErrored && !bothFailed {
		set.RightError = nonEmptyPtr(rightMeta.Error)
	}

	// Overall status: generating dominates; then a whole-set error only when
	// BOTH sides failed (nothing to show); otherwise ready. A single side's
	// failure is surfaced per-side (above) while the other side's images still
	// render, so a broken "before" build doesn't hide the "after" screenshots.
	switch {
	case leftMeta.Status == artifacts.StatusGenerating || rightMeta.Status == artifacts.StatusGenerating:
		set.Status = api.ArtifactSetStatusGenerating
		// Surface the tags known so far from any side that has already settled (a
		// settled side carries its files; a still-generating one has none), so the
		// tag filter can appear while the other side is still building.
		if tags := pendingTags(leftMeta, rightMeta); len(tags) > 0 {
			set.PendingTags = &tags
		}
		return set
	case leftErrored && rightErrored:
		set.Status = api.ArtifactSetStatusError
		msg := joinMetaErrs(leftMeta, rightMeta)
		set.Error = &msg
		return set
	default:
		set.Status = api.ArtifactSetStatusReady
	}

	// One side failed but the other rendered: fall through to Compare - the
	// errored side carries no files, so the surviving side's artifacts surface as
	// added/removed (the per-side error was set above so the panel can warn).
	deltas := mgr.Compare(leftMeta, rightMeta)
	set.Changed = artifacts.AnyChanged(deltas)
	for _, d := range deltas {
		set.Files = append(set.Files, artifactFileFromDelta(projectID, name, leftMeta.Key, rightMeta.Key, d))
	}
	return set
}

// artifactFileFromDelta folds one compared file into the API shape, wiring each
// side's blob URL from that side's cache key. Shared by the whole-set build
// (buildArtifactSet) and the artifacts WS's per-file streaming path so a streamed
// tile is identical to the one the settled set carries.
func artifactFileFromDelta(projectID, name, leftKey, rightKey string, d artifacts.FileDelta) api.ArtifactFile {
	f := api.ArtifactFile{Name: d.Name, ChangeType: api.ArtifactFileChangeType(d.Change)}
	if len(d.Tags) > 0 {
		tags := append([]string(nil), d.Tags...)
		f.Tags = &tags
	}
	if d.InLeft {
		f.LeftUrl = ptr(blobURL(projectID, name, leftKey, d.Name))
	}
	if d.InRight {
		f.RightUrl = ptr(blobURL(projectID, name, rightKey, d.Name))
	}
	if d.Unverified {
		f.Unverified = ptr(true)
	}
	if d.ChangeRatio > 0 {
		f.ChangeRatio = ptr(d.ChangeRatio)
	}
	if d.Fps > 0 {
		f.Fps = ptr(d.Fps)
	}
	if d.Width > 0 && d.Height > 0 {
		f.Width = ptr(d.Width)
		f.Height = ptr(d.Height)
	}
	if d.Dpi > 0 {
		f.Dpi = ptr(d.Dpi)
	}
	if d.Size > 0 {
		f.Size = ptr(d.Size)
	}
	return f
}

// pendingTags gathers the deduped, sorted union of every tag carried by the
// files of the given metas. While a set generates, a settled side has files (so
// contributes its tags) and a still-generating side has none, so this exposes
// the tags learned so far - letting the filter bar show before both sides settle.
func pendingTags(metas ...artifacts.Meta) []string {
	seen := map[string]struct{}{}
	for _, m := range metas {
		for _, f := range m.Files {
			for _, t := range f.Tags {
				seen[t] = struct{}{}
			}
		}
	}
	if len(seen) == 0 {
		return nil
	}
	out := make([]string, 0, len(seen))
	for t := range seen {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// toAPILog converts the manager's captured log lines into the API shape. It
// always returns a non-nil (possibly empty) slice so the field serializes as [].
func toAPILog(lines []artifacts.LogLine) []api.ArtifactLogLine {
	out := make([]api.ArtifactLogLine, 0, len(lines))
	for _, l := range lines {
		out = append(out, api.ArtifactLogLine{Text: l.Text, Stream: api.ArtifactLogLineStream(l.Stream)})
	}
	return out
}

// artifactBase builds the path prefix identifying one artifact entry, laid out
// to mirror the on-disk entry dir (out/<script>/<kind>/<id>/). A key that is not
// the expected "<kind>/<id>" shape yields "" so the caller emits no URL rather
// than a half-formed one - keyRe is enforced again server-side, this is just to
// avoid minting a path that could never resolve.
func artifactBase(projectID, script, key string) string {
	kind, id, ok := strings.Cut(key, "/")
	if !ok || kind == "" || id == "" {
		return ""
	}
	return fmt.Sprintf("/api/projects/%s/artifacts/%s/%s/%s",
		url.PathEscape(projectID), url.PathEscape(script), url.PathEscape(kind), url.PathEscape(id))
}

// blobURL builds the (same-origin) URL the frontend fetches an artifact file
// from. The file goes LAST and unescaped-per-segment, so the URL ends in the
// real filename - which is what a browser's "Save image as..." offers, and why
// this is a path rather than ?file=. An artifact's contents can nest, so each
// segment is escaped individually and the separators are kept.
func blobURL(projectID, script, key, file string) string {
	base := artifactBase(projectID, script, key)
	if base == "" {
		return ""
	}
	parts := strings.Split(strings.TrimPrefix(filepath.ToSlash(file), "/"), "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return base + "/files/" + strings.Join(parts, "/")
}

// logURL builds the (same-origin) URL the frontend fetches a settled side's
// persisted build log from (see HandleArtifactLog).
func logURL(projectID, script, key string) string {
	base := artifactBase(projectID, script, key)
	if base == "" {
		return ""
	}
	return base + "/log"
}

// nonEmptyPtr returns &s, or nil when s is empty, so an absent progress line
// serializes as null rather than "".
func nonEmptyPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// earliestStart returns the earliest non-zero of two Unix start times (0 if both
// are zero), so the elapsed-time header counts from whichever side began first.
func earliestStart(a, b int64) int64 {
	switch {
	case a == 0:
		return b
	case b == 0:
		return a
	case b < a:
		return b
	default:
		return a
	}
}

// HandleArtifactLog serves the persisted build log (JSON {lines:[...]}) for one
// settled side of a script, so the panel can reopen the log after generation
// finishes. Hand-served (like HandleArtifactBlob; tag `manual`) because
// it is addressed by the opaque (script, key) URL the set hands out.
func (s *Server) HandleArtifactLog(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project_id")
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil || s.Artifacts == nil {
		http.NotFound(w, r)
		return
	}
	script, key, _ := artifactPathParts(r)
	mgr := s.Artifacts.Manager(projectRoot)
	lines, ok := mgr.ReadLog(script, key)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=300")
	api.WriteJSON(w, http.StatusOK, api.ArtifactLogResponse{Lines: toAPILog(lines)})
}

// HandleArtifactBlob serves a single generated artifact file. It is registered
// hand-served (tag `manual`) because it returns raw image bytes and needs the
// ResponseWriter directly for ServeContent.
func (s *Server) HandleArtifactBlob(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project_id")
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil || s.Artifacts == nil {
		http.NotFound(w, r)
		return
	}

	script, key, file := artifactPathParts(r)
	mgr := s.Artifacts.Manager(projectRoot)
	path, contentType, err := mgr.BlobPath(script, key, file)
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
	setBlobSecurityHeaders(w, contentType)
	w.Header().Set("Cache-Control", "public, max-age=300")
	if artifacts.IsDownloadName(path) {
		// Download-class artifacts (an .apk, a .zip) save to disk on click
		// instead of rendering inline.
		w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(path)+`"`)
	}
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}

// artifactPathParts pulls an artifact's identifying triple out of the request
// path. The route is
// /api/projects/{project_id}/artifacts/{script}/{key_kind}/{key_id}/... , which
// mirrors the on-disk entry (out/<script>/<kind>/<id>/) exactly, so the key is
// simply its two segments rejoined - the same "<kind>/<id>" string the manager
// stores and keyRe validates. Callers pass the result straight to BlobPath /
// ReadLog, which do the validating; nothing here needs to trust it.
//
// `file` is the trailing {file...} wildcard and MAY contain slashes, since an
// artifact's contents can nest. BlobPath confines it to the entry directory.
func artifactPathParts(r *http.Request) (script, key, file string) {
	return r.PathValue("script"),
		r.PathValue("key_kind") + "/" + r.PathValue("key_id"),
		r.PathValue("file")
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
