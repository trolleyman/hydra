package web

import (
	"embed"
	"regexp"
)

//go:embed all:dist
var FrontendAssets embed.FS

//go:embed scripts/routes-regex.txt
var RoutesRegexString string

var RoutesRegex regexp.Regexp = *regexp.MustCompile(RoutesRegexString)
