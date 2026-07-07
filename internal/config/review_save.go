package config

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
)

// SaveReviewLocal persists the [review] table into the project's personal
// (.gitignored) .hydra/config.local.toml, which is the last-wins layer. Only the
// [review] block is rewritten - every other section of config.local.toml is
// preserved verbatim - so the web Settings editor can override review defaults
// per-user without disturbing team config.toml or other local sections.
//
// The update is merged onto config.local.toml's OWN existing [review] values
// (loaded standalone, not the fully-resolved config), so a field the editor does
// not send stays as it was set locally rather than being dropped.
func SaveReviewLocal(projectRoot string, update ReviewConfig) error {
	path := paths.GetProjectConfigLocalPath(projectRoot)

	base := ReviewConfig{}
	if existing, err := LoadFile(path); err == nil && existing != nil && existing.Review != nil {
		base = *existing.Review
	}
	base.Merge(update)

	existingBytes, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return errtrace.Wrap(err)
	}
	content := replaceReviewTable(string(existingBytes), renderReviewBlock(base))

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return errtrace.Wrap(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return errtrace.Wrap(err)
	}
	return nil
}

// renderReviewBlock renders the [review] table as TOML lines, emitting only the
// fields that are set (non-nil). Written by hand (like renderDeploy) so the file
// stays readable. ReviewConfig has no sub-tables, so the block is the header plus
// its key/value lines.
func renderReviewBlock(r ReviewConfig) []string {
	out := []string{"[review]"}
	addStr := func(key string, v *string) {
		if v != nil {
			out = append(out, key+" = "+tomlStringValue(*v))
		}
	}
	addBool := func(key string, v *bool) {
		if v != nil {
			out = append(out, key+" = "+strconv.FormatBool(*v))
		}
	}
	addStr("provider", r.Provider)
	addStr("remote", r.Remote)
	addStr("target_branch", r.TargetBranch)
	addStr("auth", r.Auth)
	addStr("default_action", r.DefaultAction)
	addStr("push_branch_template", r.PushBranchTemplate)
	addBool("draft", r.Draft)
	addBool("squash", r.Squash)
	addBool("delete_remote_branch", r.DeleteRemoteBranch)
	addBool("require_local_tests", r.RequireLocalTests)
	addBool("publish_when_green", r.PublishWhenGreen)
	if len(r.ProtectedBranches) > 0 {
		quoted := make([]string, len(r.ProtectedBranches))
		for i, b := range r.ProtectedBranches {
			quoted[i] = tomlStringValue(b)
		}
		out = append(out, "protected_branches = ["+strings.Join(quoted, ", ")+"]")
	}
	return out
}

// localConfigHeader is the comment prepended to a freshly-created config.local.toml.
const localConfigHeader = "# Hydra personal config overrides - .gitignored, per-user, never committed.\n" +
	"# Written by the web Settings editor; you can also hand-edit it. Values here\n" +
	"# win over .hydra/config.toml.\n\n"

// replaceReviewTable returns content with its top-level [review] table replaced
// by block (a rendered [review] header + keys). If content has no [review]
// table, block is appended; if content is empty, a documented file is created.
// Every other line is preserved verbatim.
func replaceReviewTable(content string, block []string) string {
	blockStr := strings.Join(block, "\n")
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	if strings.TrimSpace(normalized) == "" {
		return localConfigHeader + blockStr + "\n"
	}

	lines := strings.Split(normalized, "\n")
	start, end := -1, len(lines)
	for i, ln := range lines {
		name, ok := topLevelTableName(ln)
		if !ok {
			continue
		}
		if start == -1 {
			if name == "review" {
				start = i
			}
			continue
		}
		// First top-level table header after [review] ends the block.
		end = i
		break
	}

	if start == -1 {
		// No existing [review] table: append after the current content.
		trimmed := strings.TrimRight(normalized, "\n")
		return trimmed + "\n\n" + blockStr + "\n"
	}

	before := strings.TrimRight(strings.Join(lines[:start], "\n"), "\n")
	after := strings.TrimLeft(strings.Join(lines[end:], "\n"), "\n")

	var b strings.Builder
	if before != "" {
		b.WriteString(before)
		b.WriteString("\n\n")
	}
	b.WriteString(blockStr)
	b.WriteString("\n")
	if after != "" {
		b.WriteString("\n")
		b.WriteString(strings.TrimRight(after, "\n"))
		b.WriteString("\n")
	}
	return b.String()
}

// topLevelTableName returns the table name of a TOML table-header line
// (`[name]` or `[[name]]`), or ok=false for anything else (blank, comment,
// key/value). Only the first bracket segment is returned, so `[review]` yields
// "review" and `[[tests]]` yields "tests".
func topLevelTableName(line string) (string, bool) {
	t := strings.TrimSpace(line)
	if t == "" || strings.HasPrefix(t, "#") || !strings.HasPrefix(t, "[") {
		return "", false
	}
	t = strings.TrimPrefix(t, "[")
	t = strings.TrimPrefix(t, "[") // array-of-tables [[name]]
	if idx := strings.IndexByte(t, ']'); idx >= 0 {
		t = t[:idx]
	}
	return strings.TrimSpace(t), true
}
