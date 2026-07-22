#!/usr/bin/env bash
set -euo pipefail

# Replace the disposable chat E2E checkout with a detached worktree at the
# current development branch, build it, and run an isolated Hydra server.
source_checkout="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
git_common_dir="$(git -C "$source_checkout" rev-parse --path-format=absolute --git-common-dir)"
repository="$(dirname "$git_common_dir")"
target="/home/callum/code/hydra-chat-e2e"
branch="hydra/hey-could-you-look-at-how-i-could"

if [[ "$target" != "/home/callum/code/hydra-chat-e2e" ]]; then
  echo "Refusing to replace unexpected target: $target" >&2
  exit 1
fi

# Remove it through Git when it is already a registered worktree. A previous
# standalone clone is not registered, so remove only the exact disposable path.
git -C "$repository" worktree remove --force "$target" 2>/dev/null || true
if [[ -e "$target" || -L "$target" ]]; then
  rm -rf -- "$target"
fi

git -C "$repository" worktree prune
git -C "$repository" worktree add --detach "$target" "$branch"

cd "$target/web"
bun install
bun run build

cd "$target"
GOFLAGS="${GOFLAGS:+$GOFLAGS }-buildvcs=false" mage build
mkdir -p .hydra/test-bin
go build -buildvcs=false -o .hydra/test-bin/hydra .

mkdir -p .hydra/test-runtime .hydra/test-config .hydra/test-tmp

echo "Starting isolated Hydra at http://127.0.0.1:27600"
exec env \
  XDG_RUNTIME_DIR="$target/.hydra/test-runtime" \
  XDG_CONFIG_HOME="$target/.hydra/test-config" \
  TMPDIR="$target/.hydra/test-tmp" \
  HYDRA_API_ADDR=127.0.0.1:27600 \
  "$target/.hydra/test-bin/hydra" server
