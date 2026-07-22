#!/usr/bin/env bash
set -euo pipefail

# Update the chat E2E detached worktree to the current development branch,
# build it, and run an isolated Hydra server. Existing runtime state under
# .hydra/local is retained between runs.
source_checkout="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
git_common_dir="$(git -C "$source_checkout" rev-parse --path-format=absolute --git-common-dir)"
repository="$(dirname "$git_common_dir")"
target="/home/callum/code/hydra-chat-e2e"
branch="hydra/hey-could-you-look-at-how-i-could"

if [[ -d "$target/.git" || -f "$target/.git" ]]; then
  if ! git -C "$target" diff --quiet || ! git -C "$target" diff --cached --quiet; then
    echo "Refusing to update $target: it has tracked local changes." >&2
    echo "Commit or discard them, then run this script again." >&2
    exit 1
  fi
  git -C "$target" checkout --detach "$branch"
elif [[ -e "$target" ]]; then
  echo "Refusing to replace existing non-worktree path: $target" >&2
  exit 1
else
  git -C "$repository" worktree add --detach "$target" "$branch"
fi

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
