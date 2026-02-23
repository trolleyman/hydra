package common

import (
	"regexp"
	"strings"
)

var (
	reNonAlphaNum = regexp.MustCompile(`[^a-z0-9\s-]`)
	reWhitespace  = regexp.MustCompile(`[\s_-]+`)
	reDashes      = regexp.MustCompile(`^-+|-+$`)
)

// Slugify converts text to a slug.
func Slugify(text string, maxLength int) string {
	s := strings.ToLower(strings.TrimSpace(text))
	s = reNonAlphaNum.ReplaceAllString(s, "")
	s = reWhitespace.ReplaceAllString(s, "-")
	s = reDashes.ReplaceAllString(s, "")
	if len(s) > maxLength {
		s = s[:maxLength]
	}
	return strings.TrimRight(s, "-")
}
