# Issues

## Sandbox migration follow-ups

1. [x] macOS: per-head status reporting under `sandbox-exec`. `trigger-hook` honours `HYDRA_STATUS_PATH`/`HYDRA_STATUS_LOG_PATH`; the sandbox keeps the status files at their real host paths, makes them writable (bind on Linux, `allow file-write*` on macOS), and hooks invoke the hydra binary at its real path. _Still TODO: validate the generated seatbelt profile + claude hook-registration on a real Mac (macOS has no bind mounts, so injecting settings.json hooks is unsolved there)._
2. [x] Web Settings: replaced the Docker fields with a sandbox-policy editor — network on/off + allowed hosts, and writable/masked/restore-RO path lists.
3. [ ] Network: enforce `allowed_hosts`. The config field is reserved but unenforced; today only full network on/off works. Implement a filtering HTTPS-CONNECT proxy the sandbox is forced through (best-effort without root).
4. [ ] Windows: implement the Windows Sandbox backend and ConPTY attach (currently stubbed with a clear "not supported" error).
5. [x] Renamed the repurposed fields `ContainerID`/`ContainerStatus` → `SessionPID`/`SessionStatus` (DB, `Head`, HTTP handlers, and the API JSON: `session_pid` integer + `session_status`). API + TS client regenerated, frontend updated.
6. [x] Fixed `TestGetDevToolsConfig`: it now seeds a temp config dir with a known instance UUID instead of hard-coding `"test-uuid"`.

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
17. [ ] Custom things that can be shown in both versions that have changed, without having to store them in the index - e.g. screenshots. Only show if they're different. This should be configurable by project.
