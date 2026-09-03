package http

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/forge"
	"github.com/trolleyman/hydra/internal/reviewstore"
)

type parsedSuggestion struct {
	Start       int
	End         int
	Replacement string
	Fingerprint string
	Expected    *string
	Applied     bool
}

type suggestionEdit struct {
	Number     int
	NoteID     string
	Path       string
	Suggestion parsedSuggestion
}

// parseReviewSuggestion extracts the single fenced suggestion supported by both
// GitHub and GitLab. GitHub supplies a multi-line range on the thread; GitLab can
// also encode relative start/end offsets in the fence info string.
func parseReviewSuggestion(note forge.Note, thread forge.Thread) (parsedSuggestion, bool) {
	if note.Suggestion != nil {
		s := note.Suggestion
		if (!s.Appliable && !s.Applied) || s.FromLine <= 0 || s.ToLine < s.FromLine {
			return parsedSuggestion{}, false
		}
		expected := strings.TrimSuffix(strings.ReplaceAll(s.FromContent, "\r\n", "\n"), "\n")
		replacement := strings.TrimSuffix(strings.ReplaceAll(s.ToContent, "\r\n", "\n"), "\n")
		fingerprint := suggestionFingerprint(thread.Path, s.FromLine, s.ToLine, replacement)
		return parsedSuggestion{Start: s.FromLine, End: s.ToLine, Replacement: replacement, Fingerprint: fingerprint, Expected: &expected, Applied: s.Applied}, true
	}

	lines := strings.Split(strings.ReplaceAll(note.Body, "\r\n", "\n"), "\n")
	var found *parsedSuggestion
	for i, line := range lines {
		info := strings.TrimSpace(line)
		if info != "```suggestion" && !strings.HasPrefix(info, "```suggestion:") {
			continue
		}
		endFence := -1
		for j := i + 1; j < len(lines); j++ {
			if strings.TrimSpace(lines[j]) == "```" {
				endFence = j
				break
			}
		}
		if endFence < 0 || found != nil || thread.Line <= 0 {
			return parsedSuggestion{}, false
		}

		start, end := thread.Line, thread.Line
		if thread.StartLine > 0 {
			start = thread.StartLine
		}
		if suffix, ok := strings.CutPrefix(info, "```suggestion:"); ok {
			plus := strings.LastIndex(suffix, "+")
			if plus <= 0 {
				return parsedSuggestion{}, false
			}
			before, err1 := strconv.Atoi(suffix[:plus])
			after, err2 := strconv.Atoi(suffix[plus+1:])
			if err1 != nil || err2 != nil {
				return parsedSuggestion{}, false
			}
			start, end = thread.Line+before, thread.Line+after
		}
		if start <= 0 || end < start {
			return parsedSuggestion{}, false
		}
		replacement := strings.Join(lines[i+1:endFence], "\n")
		value := parsedSuggestion{Start: start, End: end, Replacement: replacement, Fingerprint: suggestionFingerprint(thread.Path, start, end, replacement)}
		if expected, ok := expectedSuggestionSource(note.DiffHunk, start, end); ok {
			value.Expected = &expected
		}
		found = &value
		i = endFence
	}
	if found == nil {
		return parsedSuggestion{}, false
	}
	return *found, true
}

func suggestionFingerprint(path string, start, end int, replacement string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d\x00%s", path, start, end, replacement))))
}

var suggestionHunkHeader = regexp.MustCompile(`^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@`)

// expectedSuggestionSource reads the current-side lines out of GitHub's diffHunk.
// Removed lines do not advance the new-side counter; context and additions do.
func expectedSuggestionSource(hunk string, start, end int) (string, bool) {
	lines := strings.Split(strings.ReplaceAll(hunk, "\r\n", "\n"), "\n")
	if len(lines) == 0 {
		return "", false
	}
	match := suggestionHunkHeader.FindStringSubmatch(lines[0])
	if len(match) != 2 {
		return "", false
	}
	line, err := strconv.Atoi(match[1])
	if err != nil {
		return "", false
	}
	selected := make([]string, 0, end-start+1)
	for _, patchLine := range lines[1:] {
		if patchLine == "" || strings.HasPrefix(patchLine, "\\ No newline") {
			continue
		}
		switch patchLine[0] {
		case '-':
			continue
		case ' ', '+':
			if line >= start && line <= end {
				selected = append(selected, patchLine[1:])
			}
			line++
		}
	}
	if len(selected) != end-start+1 {
		return "", false
	}
	return strings.Join(selected, "\n"), true
}

func reviewSuggestionAPI(projectRoot, headID, noteID string, note forge.Note, thread forge.Thread) *api.ReviewSuggestion {
	if thread.Outdated {
		return nil
	}
	suggestion, ok := parseReviewSuggestion(note, thread)
	if !ok || (suggestion.Expected == nil && !suggestion.Applied) {
		return nil
	}
	return &api.ReviewSuggestion{
		StartLine:   suggestion.Start,
		EndLine:     suggestion.End,
		Replacement: suggestion.Replacement,
		Applied:     suggestion.Applied || reviewstore.SuggestionApplied(projectRoot, headID, noteID, suggestion.Fingerprint),
	}
}

// ApplyReviewSuggestions writes one or more numbered forge suggestions into the
// head's worktree. Every edit is resolved and validated before applySuggestionEdits
// writes anything, so an invalid member cannot leave a half-applied batch.
func (s *Server) ApplyReviewSuggestions(ctx context.Context, request api.ApplyReviewSuggestionsRequestObject) (api.ApplyReviewSuggestionsResponseObject, error) {
	projectRoot, head, errResp := s.reviewThreadHead(ctx, request.ProjectId, request.AgentId)
	if errResp != nil {
		return api.ApplyReviewSuggestions404JSONResponse(*errResp), nil
	}
	if head.Worktree == nil || head.Archived {
		return applySuggestionsBadRequest("this head has no writable worktree"), nil
	}
	if request.Body == nil || len(request.Body.Numbers) == 0 {
		return applySuggestionsBadRequest("choose at least one suggestion"), nil
	}

	threads, _ := reviewstore.LoadThreads(projectRoot, head.ID)
	edits := make([]suggestionEdit, 0, len(request.Body.Numbers))
	seen := make(map[int]bool, len(request.Body.Numbers))
	for _, number := range request.Body.Numbers {
		if seen[number] {
			continue
		}
		seen[number] = true
		noteID, _, ok := reviewstore.ForgeRef(projectRoot, head.ID, number)
		if !ok {
			return applySuggestionsBadRequest(fmt.Sprintf("#%d is not a forge review comment", number)), nil
		}
		var matched *suggestionEdit
		for _, thread := range threads {
			if thread.Outdated {
				continue
			}
			for _, note := range thread.Notes {
				if note.ID != noteID {
					continue
				}
				suggestion, ok := parseReviewSuggestion(note, thread)
				if ok && (suggestion.Expected != nil || suggestion.Applied) {
					edit := suggestionEdit{Number: number, NoteID: noteID, Path: thread.Path, Suggestion: suggestion}
					matched = &edit
				}
				break
			}
		}
		if matched == nil {
			return applySuggestionsBadRequest(fmt.Sprintf("#%d has no current suggestion to apply", number)), nil
		}
		if matched.Suggestion.Applied || reviewstore.SuggestionApplied(projectRoot, head.ID, noteID, matched.Suggestion.Fingerprint) {
			continue
		}
		edits = append(edits, *matched)
	}

	if err := applySuggestionEdits(*head.Worktree, edits); err != nil {
		return applySuggestionsBadRequest(err.Error()), nil
	}
	applied := make([]int, 0, len(edits))
	for _, edit := range edits {
		if err := reviewstore.MarkSuggestionApplied(projectRoot, head.ID, edit.NoteID, edit.Suggestion.Fingerprint); err != nil {
			return applySuggestionsBadRequest(fmt.Sprintf("the change was applied but could not be recorded: %v", err)), nil
		}
		applied = append(applied, edit.Number)
	}
	if len(applied) > 0 {
		s.notifyAgentsChanged(projectRoot, false)
	}
	return api.ApplyReviewSuggestions200JSONResponse{Applied: applied}, nil
}

type pendingFileWrite struct {
	path        string
	name        string
	mode        os.FileMode
	original    []byte
	data        []byte
	dir         *os.Root
	replacement string
	backup      string
}

func applySuggestionEdits(worktree string, edits []suggestionEdit) error {
	return errtrace.Wrap(applySuggestionEditsWithRename(worktree, edits, func(root *os.Root, oldName, newName string) error {
		return errtrace.Wrap(root.Rename(oldName, newName))
	}))
}

func applySuggestionEditsWithRename(worktree string, edits []suggestionEdit, rename func(*os.Root, string, string) error) error {
	byPath := map[string][]suggestionEdit{}
	for _, edit := range edits {
		byPath[edit.Path] = append(byPath[edit.Path], edit)
	}
	paths := make([]string, 0, len(byPath))
	for path := range byPath {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	root, err := os.OpenRoot(worktree)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer root.Close()
	writes := make([]pendingFileWrite, 0, len(byPath))
	defer func() {
		for i := range writes {
			if writes[i].replacement != "" {
				_ = writes[i].dir.Remove(writes[i].replacement)
			}
			if writes[i].backup != "" {
				_ = writes[i].dir.Remove(writes[i].backup)
			}
			_ = writes[i].dir.Close()
		}
	}()
	for _, path := range paths {
		clean, err := cleanSuggestionPath(path)
		if err != nil {
			return errtrace.Wrap(err)
		}
		dir, err := root.OpenRoot(filepath.Dir(clean))
		if err != nil {
			return errtrace.Wrap(fmt.Errorf("suggestion path escapes the head worktree: %q: %w", path, err))
		}
		name := filepath.Base(clean)
		info, err := dir.Lstat(name)
		if err != nil {
			dir.Close()
			return errtrace.Wrap(fmt.Errorf("cannot apply suggestion to %s: %w", path, err))
		}
		if info.Mode()&os.ModeSymlink != 0 {
			dir.Close()
			return errtrace.Wrap(fmt.Errorf("suggestion path escapes the head worktree: %q", path))
		}
		if !info.Mode().IsRegular() {
			dir.Close()
			return errtrace.Wrap(fmt.Errorf("cannot apply suggestion to non-file %s", path))
		}
		data, err := dir.ReadFile(name)
		if err != nil {
			dir.Close()
			return errtrace.Wrap(err)
		}
		updated, err := applyEditsToContent(path, data, byPath[path])
		if err != nil {
			dir.Close()
			return errtrace.Wrap(err)
		}
		write := pendingFileWrite{path: path, name: name, mode: info.Mode().Perm(), original: data, data: updated, dir: dir}
		write.replacement, err = stageSuggestionFile(dir, ".hydra-suggestion-*", updated, write.mode)
		if err == nil {
			write.backup, err = stageSuggestionFile(dir, ".hydra-suggestion-backup-*", data, write.mode)
		}
		writes = append(writes, write)
		if err != nil {
			return errtrace.Wrap(err)
		}
	}
	// Re-read every target only after every replacement and rollback copy is
	// staged. A concurrent edit aborts the whole batch before its first rename.
	for _, write := range writes {
		current, err := write.dir.ReadFile(write.name)
		if err != nil || !bytes.Equal(current, write.original) {
			return errtrace.Errorf("cannot apply suggestion to %s: file changed while suggestions were prepared", write.path)
		}
	}
	for i := range writes {
		write := &writes[i]
		if err := rename(write.dir, write.replacement, write.name); err != nil {
			var rollbackErr error
			for j := i - 1; j >= 0; j-- {
				if restoreErr := writes[j].dir.Rename(writes[j].backup, writes[j].name); restoreErr != nil {
					rollbackErr = errors.Join(rollbackErr, restoreErr)
				} else {
					writes[j].backup = ""
				}
			}
			return errtrace.Wrap(errors.Join(err, rollbackErr))
		}
		write.replacement = ""
	}
	return nil
}

func cleanSuggestionPath(path string) (string, error) {
	if path == "" || filepath.IsAbs(path) {
		return "", errtrace.Wrap(fmt.Errorf("invalid suggestion path %q", path))
	}
	clean := filepath.Clean(path)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errtrace.Wrap(fmt.Errorf("suggestion path escapes the head worktree: %q", path))
	}
	return clean, nil
}

func stageSuggestionFile(root *os.Root, pattern string, data []byte, mode os.FileMode) (string, error) {
	file, name, err := createSuggestionTemp(root, strings.TrimSuffix(pattern, "*"))
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	if err := file.Chmod(mode); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = root.Remove(name)
		return "", errtrace.Wrap(err)
	}
	return name, nil
}

func createSuggestionTemp(root *os.Root, prefix string) (*os.File, string, error) {
	for range 100 {
		var random [8]byte
		if _, err := rand.Read(random[:]); err != nil {
			return nil, "", errtrace.Wrap(err)
		}
		name := prefix + hex.EncodeToString(random[:])
		file, err := root.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			return file, name, nil
		}
		if !os.IsExist(err) {
			return nil, "", errtrace.Wrap(err)
		}
	}
	return nil, "", errtrace.Errorf("could not allocate temporary suggestion file")
}

func applyEditsToContent(path string, data []byte, edits []suggestionEdit) ([]byte, error) {
	newline := "\n"
	text := string(data)
	if strings.Contains(text, "\r\n") {
		newline = "\r\n"
		text = strings.ReplaceAll(text, "\r\n", "\n")
	}
	finalNewline := strings.HasSuffix(text, "\n")
	text = strings.TrimSuffix(text, "\n")
	lines := []string{}
	if text != "" {
		lines = strings.Split(text, "\n")
	}
	sort.Slice(edits, func(i, j int) bool { return edits[i].Suggestion.Start > edits[j].Suggestion.Start })
	previousStart := len(lines) + 1
	for _, edit := range edits {
		suggestion := edit.Suggestion
		if suggestion.Start < 1 || suggestion.End > len(lines) {
			return nil, errtrace.Wrap(fmt.Errorf("#%d no longer matches %s:%d-%d", edit.Number, path, suggestion.Start, suggestion.End))
		}
		if suggestion.Expected != nil {
			current := strings.Join(lines[suggestion.Start-1:suggestion.End], "\n")
			if current != *suggestion.Expected {
				return nil, errtrace.Wrap(fmt.Errorf("#%d is stale: %s:%d-%d has changed", edit.Number, path, suggestion.Start, suggestion.End))
			}
		}
		if suggestion.End >= previousStart {
			return nil, errtrace.Wrap(fmt.Errorf("suggestions overlap in %s near line %d", path, suggestion.End))
		}
		replacement := []string{}
		if suggestion.Replacement != "" {
			replacement = strings.Split(suggestion.Replacement, "\n")
		}
		start := suggestion.Start - 1
		lines = append(append(append([]string{}, lines[:start]...), replacement...), lines[suggestion.End:]...)
		previousStart = suggestion.Start
	}
	out := strings.Join(lines, newline)
	if finalNewline {
		out += newline
	}
	return []byte(out), nil
}

func applySuggestionsBadRequest(detail string) api.ApplyReviewSuggestions400JSONResponse {
	return api.ApplyReviewSuggestions400JSONResponse{Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: detail}
}
