#!/usr/bin/env bash
# Build the #34 selection harness into a single self-contained file:// HTML.
# Chrome in the sandbox can't reach the Vite HTTP server (no outbound sockets) and
# ES-module <script src> is CORS-blocked on file://, so we bundle to one inline IIFE.
# Production JSX runtime comes from tsconfig.app.json (root tsconfig has no jsx set).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-/tmp/diffsel.standalone.html}"
NODE_ENV=production bun build repro/diffsel.tsx --outfile /tmp/diffsel.bundle.js \
  --format iife --define 'process.env.NODE_ENV="production"' \
  --target browser --tsconfig-override tsconfig.app.json >/dev/null
node -e '
const fs=require("fs");
const js=fs.readFileSync("/tmp/diffsel.bundle.js","utf8").replaceAll("</script","<\\/script");
fs.writeFileSync(process.argv[1],`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>${js}</script></body></html>`);
' "$OUT"
echo "wrote $OUT"
