package web

import (
	"embed"
	"regexp"
)

// FrontendAssets is the built Vite frontend. `dist/` is git-ignored, so a
// committed dist/.gitkeep placeholder keeps the directory present in every
// checkout - otherwise this embed fails to compile ("pattern all:dist: no
// matching files found") on a tree that hasn't run the frontend build, e.g. the
// `go` [[tests]] runner. The vite build re-creates the placeholder after emptying
// the dir (see web/vite.config.ts keepDistGitkeep).
//
//go:embed all:dist
var FrontendAssets embed.FS

//go:embed scripts/routes-regex.txt
var RoutesRegexString string

var RoutesRegex regexp.Regexp = *regexp.MustCompile(RoutesRegexString)
