package web

import "embed"

//go:embed all:dist
var FrontendAssets embed.FS
