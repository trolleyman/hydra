package git

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"braces.dev/errtrace"
	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/format/diff"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/storer"
	"github.com/go-git/go-git/v5/utils/merkletrie"
)

// CommitInfo contains information about a single git commit.
type CommitInfo struct {
	SHA         string
	ShortSHA    string
	Message     string
	Subject     string
	AuthorName  string
	AuthorEmail string
	Timestamp   string
}

// DiffLineType describes the type of a diff line.
type DiffLineType string

const (
	DiffLineContext   DiffLineType = "context"
	DiffLineAddition  DiffLineType = "addition"
	DiffLineDeletion  DiffLineType = "deletion"
	DiffLineNoNewline DiffLineType = "no_newline"
)

// DiffLine represents one line in a diff hunk.
type DiffLine struct {
	Type       DiffLineType
	Content    string
	OldLineNum *int
	NewLineNum *int
}

// DiffHunk represents a single @@ ... @@ hunk in a diff.
type DiffHunk struct {
	Header   string
	OldStart int
	NewStart int
	Lines    []DiffLine
}

// DiffFile represents one file's worth of diff information.
type DiffFile struct {
	Path       string
	OldPath    *string // non-nil for renamed files
	ChangeType string  // added | modified | deleted | renamed
	Additions  int
	Deletions  int
	Binary     bool
	Hunks      []DiffHunk
}

// ListCommits returns the commits reachable from headBranch but not from baseBranch.
// Results are ordered newest-first.
func ListCommits(projectRoot, baseBranch, headBranch string) ([]CommitInfo, error) {
	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	headRef, err := repo.ResolveRevision(plumbing.Revision(headBranch))
	if err != nil {
		return nil, nil // Return empty list if headBranch doesn't exist
	}

	baseRef, err := repo.ResolveRevision(plumbing.Revision(baseBranch))
	if err != nil {
		return nil, nil // Return empty list if baseBranch doesn't exist
	}

	iter, err := repo.Log(&git.LogOptions{
		From:  *headRef,
		Order: git.LogOrderDefault,
	})
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	var commits []CommitInfo
	err = iter.ForEach(func(c *object.Commit) error {
		// Stop when we reach baseRef
		if c.Hash == *baseRef {
			return errtrace.Wrap(storer.ErrStop)
		}

		commits = append(commits, CommitInfo{
			SHA:         c.Hash.String(),
			ShortSHA:    c.Hash.String()[:7],
			Message:     c.Message,
			Subject:     strings.SplitN(c.Message, "\n", 2)[0],
			AuthorName:  c.Author.Name,
			AuthorEmail: c.Author.Email,
			Timestamp:   c.Author.When.Format("2006-01-02T15:04:05Z07:00"),
		})
		return nil
	})
	if err != nil && err != storer.ErrStop {
		return nil, errtrace.Wrap(err)
	}

	// Filter out commits that are reachable from baseBranch
	finalCommits := []CommitInfo{}
	for _, ci := range commits {
		h := plumbing.NewHash(ci.SHA)
		reachable, _ := isReachable(repo, *baseRef, h)
		if reachable {
			continue
		}
		finalCommits = append(finalCommits, ci)
	}

	return finalCommits, nil
}

func isAncestor(repo *git.Repository, ancestor, descendant plumbing.Hash) (bool, error) {
	descCommit, err := repo.CommitObject(descendant)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	ancCommit, err := repo.CommitObject(ancestor)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	return errtrace.Wrap2(descCommit.IsAncestor(ancCommit))
}

func isReachable(repo *git.Repository, from, to plumbing.Hash) (bool, error) {
	fromCommit, err := repo.CommitObject(from)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	toCommit, err := repo.CommitObject(to)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	return errtrace.Wrap2(fromCommit.IsAncestor(toCommit))
}

// GetCommitInfo retrieves information about a single commit by ref.
func GetCommitInfo(projectRoot, ref string) (*CommitInfo, error) {
	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	h, err := repo.ResolveRevision(plumbing.Revision(ref))
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("resolve revision: %w", err))
	}

	c, err := repo.CommitObject(*h)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("commit object: %w", err))
	}

	subject := strings.SplitN(c.Message, "\n", 2)[0]
	return &CommitInfo{
		SHA:         c.Hash.String(),
		ShortSHA:    c.Hash.String()[:7],
		Message:     c.Message,
		Subject:     subject,
		AuthorName:  c.Author.Name,
		AuthorEmail: c.Author.Email,
		Timestamp:   c.Author.When.Format("2006-01-02T15:04:05Z07:00"),
	}, nil
}

// GetDiff returns the parsed diff between baseRef and headRef.
func GetDiff(projectRoot, baseRef, headRef string, ignoreWhitespace, useTripleDot bool, path string, context int) ([]DiffFile, error) {
	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	baseH, err := repo.ResolveRevision(plumbing.Revision(baseRef))
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	baseCommit, err := repo.CommitObject(*baseH)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	baseTree, err := baseCommit.Tree()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	var headTree *object.Tree
	if headRef == "" {
		return nil, errtrace.Wrap(fmt.Errorf("diff against worktree not yet implemented via go-git"))
	} else {
		hH, err := repo.ResolveRevision(plumbing.Revision(headRef))
		if err != nil {
			return nil, errtrace.Wrap(err)
		}

		headCommit, err := repo.CommitObject(*hH)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}

		if useTripleDot {
			res, err := baseCommit.MergeBase(headCommit)
			if err != nil || len(res) == 0 {
				return nil, errtrace.Wrap(fmt.Errorf("could not find merge base"))
			}
			baseTree, err = res[0].Tree()
			if err != nil {
				return nil, errtrace.Wrap(err)
			}
		}
		headTree, err = headCommit.Tree()
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
	}

	changes, err := baseTree.Diff(headTree)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	patch, err := changes.Patch()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	buf := new(strings.Builder)
	encoder := diff.NewUnifiedEncoder(buf, 0)
	err = encoder.Encode(patch)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	return errtrace.Wrap2(parseDiff(buf.String()))
}

// GetDiffFiles returns the list of files that changed between baseRef and headRef.
func GetDiffFiles(projectRoot, baseRef, headRef string, useTripleDot bool) ([]DiffFile, error) {
	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	baseH, err := repo.ResolveRevision(plumbing.Revision(baseRef))
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	baseCommit, err := repo.CommitObject(*baseH)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	baseTree, err := baseCommit.Tree()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	var headTree *object.Tree
	if headRef == "" {
		return nil, errtrace.Wrap(fmt.Errorf("diff against worktree not yet implemented via go-git"))
	} else {
		hH, err := repo.ResolveRevision(plumbing.Revision(headRef))
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		headCommit, err := repo.CommitObject(*hH)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}

		if useTripleDot {
			res, err := baseCommit.MergeBase(headCommit)
			if err != nil || len(res) == 0 {
				return nil, errtrace.Wrap(fmt.Errorf("could not find merge base"))
			}
			baseTree, err = res[0].Tree()
			if err != nil {
				return nil, errtrace.Wrap(err)
			}
		}
		headTree, err = headCommit.Tree()
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
	}

	changes, err := baseTree.Diff(headTree)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	patch, err := changes.Patch()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	var files []DiffFile
	for _, fp := range patch.FilePatches() {
		from, to := fp.Files()
		path := ""
		var oldPath *string
		changeType := "modified"
		if from == nil && to != nil {
			path = to.Path()
			changeType = "added"
		} else if from != nil && to == nil {
			path = from.Path()
			changeType = "deleted"
		} else if from != nil && to != nil {
			path = to.Path()
			if from.Path() != to.Path() {
				changeType = "renamed"
				op := from.Path()
				oldPath = &op
			}
		}

		add, del := 0, 0
		for _, chunk := range fp.Chunks() {
			switch chunk.Type() {
			case diff.Add:
				add += strings.Count(chunk.Content(), "\n")
				if !strings.HasSuffix(chunk.Content(), "\n") && chunk.Content() != "" {
					add++
				}
			case diff.Delete:
				del += strings.Count(chunk.Content(), "\n")
				if !strings.HasSuffix(chunk.Content(), "\n") && chunk.Content() != "" {
					del++
				}
			}
		}

		files = append(files, DiffFile{
			Path:       path,
			OldPath:    oldPath,
			ChangeType: changeType,
			Additions:  add,
			Deletions:  del,
			Binary:     fp.IsBinary(),
		})
	}

	return files, nil
}

// GetUntrackedDiffFiles returns DiffFile summary entries for all untracked files.
func GetUntrackedDiffFiles(projectRoot string) ([]DiffFile, error) {
	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	w, err := repo.Worktree()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	status, err := w.Status()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	var files []DiffFile
	for path, stat := range status {
		if stat.Staging == git.Untracked && stat.Worktree == git.Untracked {
			content, err := os.ReadFile(filepath.Join(projectRoot, path))
			additions := 0
			if err == nil {
				additions = strings.Count(string(content), "\n")
				if len(content) > 0 && !strings.HasSuffix(string(content), "\n") {
					additions++
				}
			}
			files = append(files, DiffFile{Path: path, ChangeType: "added", Additions: additions})
		}
	}
	return files, nil
}

// GetUntrackedDiff returns full parsed diffs for untracked files.
func GetUntrackedDiff(projectRoot, path string, context int) ([]DiffFile, error) {
	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	w, err := repo.Worktree()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	status, err := w.Status()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	var files []DiffFile
	for p, stat := range status {
		if stat.Staging == git.Untracked && stat.Worktree == git.Untracked {
			if path != "" && p != path {
				continue
			}

			content, err := os.ReadFile(filepath.Join(projectRoot, p))
			if err != nil {
				continue
			}

			lines := strings.Split(string(content), "\n")
			if len(lines) > 0 && lines[len(lines)-1] == "" {
				lines = lines[:len(lines)-1]
			}

			hunk := DiffHunk{
				Header:   fmt.Sprintf("@@ -0,0 +1,%d @@", len(lines)),
				OldStart: 0,
				NewStart: 1,
			}
			for i, line := range lines {
				lineNum := i + 1
				hunk.Lines = append(hunk.Lines, DiffLine{
					Type:       DiffLineAddition,
					Content:    line,
					NewLineNum: &lineNum,
				})
			}

			files = append(files, DiffFile{
				Path:       p,
				ChangeType: "added",
				Additions:  len(lines),
				Hunks:      []DiffHunk{hunk},
			})
		}
	}
	return files, nil
}

// parseDiff parses raw diff output.
func parseDiff(rawDiff string) ([]DiffFile, error) {
	var files []DiffFile
	var cur *DiffFile
	var curHunk *DiffHunk
	oldLineNum, newLineNum := 0, 0

	finishHunk := func() {
		if curHunk != nil && cur != nil {
			cur.Hunks = append(cur.Hunks, *curHunk)
			curHunk = nil
		}
	}
	finishFile := func() {
		if cur != nil {
			finishHunk()
			if cur.ChangeType == "" {
				cur.ChangeType = "modified"
			}
			files = append(files, *cur)
			cur = nil
		}
	}

	lines := strings.Split(rawDiff, "\n")
	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "diff --git ") || strings.HasPrefix(line, "diff "):
			finishFile()
			cur = &DiffFile{}
			if idx := strings.LastIndex(line, " b/"); idx != -1 {
				cur.Path = line[idx+3:]
			} else if idx := strings.LastIndex(line, " "); idx != -1 {
				cur.Path = line[idx+1:]
			}
		case cur == nil && (strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ ")):
			cur = &DiffFile{}
			if strings.HasPrefix(line, "+++ ") {
				cur.Path = strings.TrimPrefix(line, "+++ ")
				if strings.HasPrefix(cur.Path, "b/") {
					cur.Path = cur.Path[2:]
				}
			}
		case cur == nil:
			continue
		case strings.HasPrefix(line, "new file mode"):
			cur.ChangeType = "added"
		case strings.HasPrefix(line, "deleted file mode"):
			cur.ChangeType = "deleted"
		case strings.HasPrefix(line, "rename from "):
			cur.ChangeType = "renamed"
			op := strings.TrimPrefix(line, "rename from ")
			cur.OldPath = &op
		case strings.HasPrefix(line, "rename to "):
			cur.Path = strings.TrimPrefix(line, "rename to ")
		case strings.HasPrefix(line, "Binary files"):
			cur.Binary = true
			if cur.ChangeType == "" {
				cur.ChangeType = "modified"
			}
		case strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ "):
			if cur.ChangeType == "" {
				cur.ChangeType = "modified"
			}
			if cur.Path == "" && strings.HasPrefix(line, "+++ ") {
				cur.Path = strings.TrimPrefix(line, "+++ ")
				if strings.HasPrefix(cur.Path, "b/") {
					cur.Path = cur.Path[2:]
				}
			}
		case strings.HasPrefix(line, "@@ "):
			finishHunk()
			curHunk = &DiffHunk{Header: line}
			oldLineNum, newLineNum = parseHunkHeader(line)
		case curHunk != nil:
			switch {
			case strings.HasPrefix(line, "+"):
				n := newLineNum
				curHunk.Lines = append(curHunk.Lines, DiffLine{Type: DiffLineAddition, Content: line[1:], NewLineNum: &n})
				newLineNum++
				cur.Additions++
			case strings.HasPrefix(line, "-"):
				o := oldLineNum
				curHunk.Lines = append(curHunk.Lines, DiffLine{Type: DiffLineDeletion, Content: line[1:], OldLineNum: &o})
				oldLineNum++
				cur.Deletions++
			case strings.HasPrefix(line, "\\"):
				curHunk.Lines = append(curHunk.Lines, DiffLine{Type: DiffLineNoNewline, Content: line})
			case strings.HasPrefix(line, " "):
				o, n := oldLineNum, newLineNum
				curHunk.Lines = append(curHunk.Lines, DiffLine{Type: DiffLineContext, Content: line[1:], OldLineNum: &o, NewLineNum: &n})
				oldLineNum++
				newLineNum++
			}
		}
	}
	finishFile()
	return files, nil
}

func parseHunkHeader(header string) (oldStart, newStart int) {
	parts := strings.Fields(header)
	if len(parts) < 3 {
		return 1, 1
	}
	old := strings.TrimPrefix(parts[1], "-")
	newS := strings.TrimPrefix(parts[2], "+")

	parseStart := func(s string) int {
		comma := strings.Index(s, ",")
		if comma != -1 {
			s = s[:comma]
		}
		n, _ := strconv.Atoi(s)
		return n
	}
	return parseStart(old), parseStart(newS)
}

// GetMergeBase returns the merge-base between two refs.
func GetMergeBase(projectRoot, baseRef, headRef string) (string, error) {
	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	bH, err := repo.ResolveRevision(plumbing.Revision(baseRef))
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	hH, err := repo.ResolveRevision(plumbing.Revision(headRef))
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	baseCommit, err := repo.CommitObject(*bH)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	headCommit, err := repo.CommitObject(*hH)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	res, err := baseCommit.MergeBase(headCommit)
	if err != nil || len(res) == 0 {
		return "", errtrace.Wrap(fmt.Errorf("no merge base found"))
	}
	return res[0].Hash.String(), nil
}

// HasConflicts returns true if merging headRef into baseRef would conflict.
func HasConflicts(projectRoot, baseRef, headRef string) (bool, error) {
	conflicts, err := GetConflictingFiles(projectRoot, baseRef, headRef)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	return len(conflicts) > 0, nil
}

// UncommittedSummary holds counts of uncommitted changes.
type UncommittedSummary struct {
	TrackedCount   int
	UntrackedCount int
}

// GetUncommittedSummary returns counts of tracked and untracked changes.
func GetUncommittedSummary(projectRoot string) (*UncommittedSummary, error) {
	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	w, err := repo.Worktree()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	status, err := w.Status()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	s := &UncommittedSummary{}
	for _, stat := range status {
		if stat.Staging == git.Untracked && stat.Worktree == git.Untracked {
			s.UntrackedCount++
		} else {
			s.TrackedCount++
		}
	}
	return s, nil
}

// HasUncommittedChanges returns true if there are uncommitted changes to tracked files.
func HasUncommittedChanges(projectRoot string) (bool, error) {
	s, err := GetUncommittedSummary(projectRoot)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	return s.TrackedCount > 0, nil
}

// GetConflictingFiles returns the list of files that would conflict during a merge.
func GetConflictingFiles(projectRoot, baseRef, headRef string) ([]string, error) {
	repo, err := git.PlainOpen(projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	mergeBase, err := GetMergeBase(projectRoot, baseRef, headRef)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	getNames := func(from, to string) (map[string]bool, error) {
		fromH, _ := repo.ResolveRevision(plumbing.Revision(from))
		toH, _ := repo.ResolveRevision(plumbing.Revision(to))
		fromCommit, _ := repo.CommitObject(*fromH)
		toCommit, _ := repo.CommitObject(*toH)
		fromTree, _ := fromCommit.Tree()
		toTree, _ := toCommit.Tree()
		changes, err := fromTree.Diff(toTree)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		m := make(map[string]bool)
		for _, change := range changes {
			action, _ := change.Action()
			switch action {
			case merkletrie.Modify, merkletrie.Delete:
				m[change.From.Name] = true
			case merkletrie.Insert:
				m[change.To.Name] = true
			}
		}
		return m, nil
	}
	baseChanged, err := getNames(mergeBase, baseRef)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	headChanged, err := getNames(mergeBase, headRef)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var conflicts []string
	for f := range headChanged {
		if baseChanged[f] {
			conflicts = append(conflicts, f)
		}
	}
	return conflicts, nil
}
