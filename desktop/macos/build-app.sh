#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/dist/macos/Hydra.app"
CONTENTS="$APP/Contents"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-app.sh must run on macOS (Swift/AppKit and codesign are required)." >&2
  exit 1
fi

cd "$ROOT"
mage build

rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

swift build --package-path desktop/macos -c release
cp "desktop/macos/.build/release/HydraDesktop" "$CONTENTS/MacOS/Hydra"
go build -o "$CONTENTS/Resources/HydraBackend" .
cp desktop/macos/Resources/Info.plist "$CONTENTS/Info.plist"
printf 'APPL????' > "$CONTENTS/PkgInfo"
chmod 755 "$CONTENTS/MacOS/Hydra" "$CONTENTS/Resources/HydraBackend"

# Ad-hoc signing makes the development bundle internally consistent. A release
# identity/notarization pipeline can replace this once lifecycle behavior is
# validated on hardware.
codesign --force --deep --sign - "$APP"
echo "$APP"
