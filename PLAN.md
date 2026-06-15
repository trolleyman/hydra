# Issues

## Sandbox migration follow-ups

1. [ ] macOS: implement per-head status reporting under `sandbox-exec`. There are no bind mounts on macOS, so the Linux trick of binding a per-head `status.json` into `$HOME/.hydra` doesn't apply — pass a `HYDRA_STATUS_PATH` env var pointing at a writable per-head path (and `allow file-write*` it in the seatbelt profile) and have `trigger-hook` honour it. Validate the generated profile on a real Mac.
2. [ ] Web Settings: replace the deprecated Docker fields (now no-ops) with a sandbox-policy editor — writable paths, masked paths, restore-RO paths, and network (on/off + allowed hosts).
3. [ ] Network: enforce `allowed_hosts`. The config field is reserved but unenforced; today only full network on/off works. Implement a filtering HTTPS-CONNECT proxy the sandbox is forced through (best-effort without root).
4. [ ] Windows: implement the Windows Sandbox backend and ConPTY attach (currently stubbed with a clear "not supported" error).
5. [ ] Rename the repurposed fields `ContainerID`/`ContainerStatus` → `SessionPID`/`SessionStatus` (DB, `Head`, and the `container_id`/`container_status` API JSON) once the frontend is updated to match.
6. [ ] Fix `TestGetDevToolsConfig`: it hard-codes the instance UUID `"test-uuid"` and fails on any machine whose `~/.config/hydra/uuid.txt` differs (i.e. always). Inject the UUID via a test fixture/env instead.

## Agent UX

7. [ ] Run a Go language server inside (or alongside) sandboxed agents so the agent can query LSP information (definitions, references, diagnostics) instead of only reading files.
8. [ ] Support `hydra attach <id> [command]`: run an arbitrary command (e.g. `bash`) in the head's sandbox instead of attaching to the agent. If the head's session has stopped but its worktree/branch still exist, resume the agent first.
9. [ ] When merging or killing a head, move it into a transitional state and return an HTTP status indicating work-in-progress, so the UI button stays disabled only until the operation completes.
10. [ ] Use `status_log.jsonl` to surface richer agent status/progress.
11. [ ] Stream command stdout/stderr live and prefix log lines (e.g. `[stdout]` / `[stderr]`), preserving interleaving instead of buffering and printing everything at once.

## Diff viewer

12. [ ] Auto-load diffs for short changes (< 1000 lines) via the diff-files endpoint instead of defaulting to "No changes loaded" — currently each file must be loaded manually.
13. [ ] Diff-viewer selectors: let the left selector pick "Latest commit" when the right is on "Latest changes" (and auto-select this combo when the uncommitted-changes button is pressed); order the left selector with the latest commit at the top and `main` at the bottom; forbid selecting a left state at/after the right (and a right state at/before the left).
14. [ ] Fix the uncommitted-changes button breaking the diff-header layout — it adds a new line that splits the left buttons from the settings button (likely the tooltip).
15. [ ] Make the expand-lines buttons work in demo mode (may need a new API endpoint).
16. [ ] Fix diff-viewer comments: the add-comment button is half-clipped (overflow / z-index), the comment dialog flickers in and out, and Ctrl/Cmd+Enter doesn't submit. Render the comment inline by splitting the diff (GitLab-style) so the diff and the comment box are visible at the same time.
