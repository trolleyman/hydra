# Issues

1. [x] **[Sandbox]** macOS: per-head status reporting under `sandbox-exec`. `trigger-hook` honours `HYDRA_STATUS_PATH`/`HYDRA_STATUS_LOG_PATH`; the sandbox keeps the status files at their real host paths, makes them writable (bind on Linux, `allow file-write*` on macOS), and hooks invoke the hydra binary at its real path. _Still TODO: validate the generated seatbelt profile + claude hook-registration on a real Mac (macOS has no bind mounts, so injecting settings.json hooks — and the Gemini/Copilot system-prompt context files seeded the same way — is unsolved there; Claude's `--append-system-prompt` works regardless)._

2. [x] **[Sandbox]** Web Settings: replaced the Docker fields with a sandbox-policy editor — network on/off + allowed hosts, and writable/masked/restore-RO path lists.

3. [ ] **[Sandbox]** Network: enforce `allowed_hosts`. The config field is reserved but unenforced; today only full network on/off works. Implement a filtering HTTPS-CONNECT proxy the sandbox is forced through (best-effort without root).

4. [ ] **[Sandbox]** Windows: implement the Windows Sandbox backend and ConPTY attach (currently stubbed with a clear "not supported" error).

5. [x] **[Sandbox]** Renamed the repurposed fields `ContainerID`/`ContainerStatus` → `SessionPID`/`SessionStatus` (DB, `Head`, HTTP handlers, and the API JSON: `session_pid` integer + `session_status`). API + TS client regenerated, frontend updated.

6. [x] **[Sandbox]** Fixed `TestGetDevToolsConfig`: it now seeds a temp config dir with a known instance UUID instead of hard-coding `"test-uuid"`.

7. [ ] **[Agent UX]** Run a Go language server inside (or alongside) sandboxed agents so the agent can query LSP information (definitions, references, diagnostics) instead of only reading files.

8. [ ] **[Agent UX]** Support `hydra attach <id> [command]`: run an arbitrary command (e.g. `bash`) in the head's sandbox instead of attaching to the agent. If the head's session has stopped but its worktree/branch still exist, resume the agent first.

9. [ ] **[Agent UX]** When merging or killing a head, move it into a transitional state and return an HTTP status indicating work-in-progress, so the UI button stays disabled only until the operation completes.

10. [ ] **[Agent UX]** Use `status_log.jsonl` to surface richer agent status/progress.

11. [ ] **[Agent UX]** Stream command stdout/stderr live and prefix log lines (e.g. `[stdout]` / `[stderr]`), preserving interleaving instead of buffering and printing everything at once.

12. [ ] **[Diff viewer]** Auto-load diffs for short changes (< 1000 lines) via the diff-files endpoint instead of defaulting to "No changes loaded" — currently each file must be loaded manually.

13. [ ] **[Diff viewer]** Diff-viewer selectors: let the left selector pick "Latest commit" when the right is on "Latest changes" (and auto-select this combo when the uncommitted-changes button is pressed); order the left selector with the latest commit at the top and `main` at the bottom; forbid selecting a left state at/after the right (and a right state at/before the left).

14. [ ] **[Diff viewer]** Fix the uncommitted-changes button breaking the diff-header layout — it adds a new line that splits the left buttons from the settings button (likely the tooltip).

15. [ ] **[Diff viewer]** Make the expand-lines buttons work in demo mode (may need a new API endpoint).

16. [ ] **[Diff viewer]** Fix diff-viewer comments: the add-comment button is half-clipped (overflow / z-index), the comment dialog flickers in and out, and Ctrl/Cmd+Enter doesn't submit. Render the comment inline by splitting the diff (GitLab-style) so the diff and the comment box are visible at the same time.

17. [x] **[Diff viewer]** Custom things that can be shown in both versions that have changed, without having to store them in the index — e.g. screenshots. Only show if they're different. Configurable per project.

    Projects declare one or more generator scripts in `.hydra/config.toml`:

    ```toml
    [[artifacts]]
    name = "screenshots"
    command = "bun run screenshots.ts"   # run via `sh -c`
    timeout_sec = 600                     # optional; default 300
    ```

    Each script runs with the checkout as its working directory and these env
    vars: `HYDRA_ARTIFACT_OUTPUT` (the dir it must write image files into —
    `.png/.jpg/.jpeg/.gif/.webp/.avif/.svg/.bmp/.pdf`), `HYDRA_ARTIFACT_SOURCE`
    (the checkout dir), and `HYDRA_ARTIFACT_REF` (the resolved ref).

    The daemon runs scripts on demand for both sides of the diff selection (left
    = a committed ref via an ephemeral detached worktree; right = the same, or
    the head's uncommitted working tree run in place). Results live in the
    gitignored `.hydra/artifacts/` (never committed), keyed by an immutable
    version id (resolved commit SHA, or a hash of the working-tree state) so
    repeat views are free. A per-entry lock collapses duplicate concurrent
    generations; a background pruner evicts entries older than 7 days and caps
    total cache size at 2 GiB; ephemeral checkouts are cleaned on boot. The diff
    viewer shows a side-by-side "Artifacts" panel, polling while generation is in
    flight and surfacing only the files that differ between versions (sets with
    no visual changes collapse to a one-line note).

    Design decisions (made without user input): scripts originally ran on the
    host as the invoking user, bounded by a wall-clock timeout; #26 moved them
    inside the OS sandbox (the host path is now an explicit `unsafe_host` opt-out).
    Artifact change-type strings collide with the diff
    `change_type` enum, so oapi-codegen now prefixes both (`DiffFileChangeType*`,
    `ArtifactFileChangeType*`). The blob bytes are served by a dedicated
    `/artifacts/projects/{project_id}/blob` route (raw image bytes, not JSON, so
    it lives outside the OpenAPI handler).

18. [x] **[Bug]** **A sandboxed head couldn't `git commit` its own work.** The sandbox made only the worktree's *files* writable (`internal/sandbox/linux.go` `addRWDir(opts.WorktreePath)`), but a linked worktree's git metadata lives in the main repo's git common dir, which stayed read-only: `<worktree>/.git` is a pointer to `<main-repo>/.git/worktrees/<id>`, and a commit writes the index/`HEAD`/reflog there plus objects/refs under `<main-repo>/.git`. None were bound writable, so `git add`/`git commit` failed with `Unable to create .../index.lock: Read-only file system` (it bit the #17 work, which had to be committed from the host).

    _Fixed: `git.GetCommonDir` resolves the shared git dir, plumbed into `sandbox.Options.GitCommonDir` (set in `internal/heads/heads.go` for spawn/resume/shell); `internal/sandbox/linux.go` binds it writable next to the worktree and `darwin.go` adds the equivalent `(allow file-write* …)`. Verify on host — bwrap can't run in-session (`sandbox-userns-blocked-in-session`)._

19. [x] **[Bug]** **`mage` couldn't write its compiled-magefile cache in the sandbox.** mage defaults `MAGEFILE_CACHE` to `~/.magefile`, which wasn't under any writable path, so `mage <target>` failed with `copying … /home/<user>/.magefile/…: read-only file system` (workaround was `MAGEFILE_CACHE=/tmp/... mage build`).

    _Fixed: added `~/.magefile` to this repo's `.hydra/config.toml` `[defaults.sandbox] writable_paths` (alongside the Go/bun caches). For out-of-the-box coverage of every project, `~/.magefile` could instead go in `sandbox.Defaults().WritablePaths`._

20. [x] **[Sandbox]** Removed the remaining Docker dead code now that the backend is OS sandboxing: the no-op `cleanBuildCache` endpoint + `CleanCacheResponse`, the `default_dockerfiles` and `AgentConfig` `dockerfile*`/`context`/`dockerignore_contents` fields, the never-emitted `build_finished` terminal event, the unused `ContainerName` DB column and dead `internal/common/user.go`, and renamed the repurposed `docker_error` API field → `sandbox_error`. Refreshed the demo `simulation.go` fixtures off Docker terms.

21. [x] **[Agent UX]** The pre-prompt is now delivered as a real system prompt rather than prepended to the user task: Claude via `--append-system-prompt`; Gemini via captured-default-plus-append through `GEMINI_SYSTEM_MD` (falling back to a `GEMINI.md` context file); Copilot via `~/.copilot/copilot-instructions.md`. Rewrote the prompt to tell the agent it can't install anything or escape the sandbox, and to ask the user to change `[*.sandbox]` settings instead.

22. [x] **[Agent UX]** Web terminal "+" is now a split dropdown to open either a **sandboxed shell** (default, confined like the agent) or a **regular host shell** (`sandbox.Options.NoSandbox`, full host access) sharing the worktree.

23. [x] **[Sandbox]** Removed the `shared_mounts` config field everywhere (it only ever appended to writable paths); use `[*.sandbox] writable_paths` instead. Migrated this repo's `.hydra/config.toml` and dropped its dead `dockerfile_contents`.

24. [x] **[Sandbox]** Fixed the sandboxed bash shell: re-expose `~/.config/mise/config.toml` read-only so mise finds its global config; omit bwrap `--new-session` for interactive shells (`sandbox.Options.Interactive`) so job control works; and auto-add the worktree to `MISE_TRUSTED_CONFIG_PATHS` when the host already trusts the project's mise config.

25. [x] **[Bug]** **Agents weren't resumed/were left stuck after the daemon restarted or the agent exited.** `HandleTerminalWS` now lazily resumes a non-live head with a worktree when its page is opened, using `Registry.IsLive` (exists AND not exited — `Get` wrongly counted lingering exited sessions as live, so refresh attached to a dead session and stuck on "connection closed"). Resume argv is now non-interactive and keeps its mode flags: Claude `--continue` (not `--resume`, which popped a session picker that exits on Esc), Gemini `--resume latest`, all retaining `--dangerously-skip-permissions`/`--approval-mode=yolo`/`--yolo` (+ Claude `--append-system-prompt`).

26. [x] **[Security]** **Run artifact generator commands inside the sandbox.** Previously `internal/artifacts/artifacts.go` ran each `[[artifacts]]` command directly on the host (`exec.CommandContext("sh", "-c", spec.Command)` with `os.Environ()`) — no bwrap/sandbox-exec, unlike agents and the web shells. This was a documented #17 follow-up, but it was a real **sandbox-escape / RCE**, not just "trusted config runs on the host":

    - The *command string* is trusted (read from the daemon's live merged config in `http/artifacts.go`, **not** from the checked-out ref), so an attacker can't inject a new command via a branch's `.hydra/config.toml`.
    - But the trusted command **executes inside an attacker-controllable checkout** (`runDir` = an ephemeral worktree of a caller-supplied `BaseRef`/`HeadRef`, the agent's own branch, or the head's uncommitted working tree). Build tooling run there executes the ref's code: e.g. the home-page screenshot generator (#27) runs `bun install` (which fires `postinstall`/`preinstall` lifecycle scripts from the checkout's `package.json`) and `bun take-screenshot.ts` (the ref's own copy). So **a sandboxed agent can write a malicious `package.json` postinstall, and the moment a user opens the Artifacts panel on its diff, that code runs unsandboxed on the host with the user's credentials + network** — defeating the agent sandbox.

    _Fix:_ route the command through `sandbox.BuildSpec` like `internal/heads/heads.go` does for spawn/resume/shell — checkout dir + `HYDRA_ARTIFACT_OUTPUT` dir writable, the dev caches writable (go-build/bun/magefile, as agents get), git common dir writable for the ephemeral worktree, **network enabled** (matches the agent default; needed for cold `bun install`/`go mod download`, and warm caches keep it mostly offline anyway). Verify on host — bwrap can't run nested in-session (`sandbox-userns-blocked-in-session`).

    _Escape hatch (design decision):_ support an explicit per-script opt-out so a genuinely self-contained, audited command can run on the host. **Red flag to respect:** "trusted config" only authorizes *which command runs* — it does **not** make the *diffed ref's contents* safe, and that is where the danger is. The opt-out must therefore be sandboxed-by-default and named to signal danger (e.g. `unsafe_host = true`, not a bland `sandbox = false`), documented as "runs the diffed ref's code on the host unsandboxed — only enable for audited commands when you trust every ref you'll compare." Heavy builds (like the screenshot generator) are the scripts most tempted to set it *and* the ones running the most untrusted code, so it should not be made to look routine.

    _Lesser hardening (same pass):_ cap concurrent generations (distinct refs currently build in parallel with only a per-key dedupe lock — a mild fork-bomb/DoS vector) and consider CPU/mem/process limits in addition to the existing wall-clock timeout.

    _Fixed:_ `artifacts.generate` now routes the command through `sandbox.BuildSpec` via a new `Manager.buildCommandSpec`. By default the command runs confined (the launch `Spec` is run with `exec.CommandContext`, mirroring `session/pty_unix.go` but without a PTY): the checkout/`WorktreePath` + `HYDRA_ARTIFACT_OUTPUT` dir + dev caches (`config.ResolveSandboxOptions("")`) + git common dir are writable, credentials are masked, `HardenGUI`/`Seccomp` on, **network enabled**, and the checkout dir is added to `MISE_TRUSTED_CONFIG_PATHS` when the host trusts the project (the `miseTrustEnv`/`hostTrustsMiseConfig` helpers moved from `internal/heads` to `sandbox.MiseTrustEnv` so both reuse them). The escape hatch shipped as `config.ArtifactScript.UnsafeHost` (`unsafe_host = true`), which sets `sandbox.Options.NoSandbox` so the command runs unconfined on the host — documented in the struct as "runs the diffed ref's code on the host unsandboxed; only for audited commands when you trust every ref you'll compare," deliberately not used by the #27 screenshot generator. Concurrent generations are capped by a `maxConcurrentGen` (2) semaphore in the `Manager`, on top of the existing wall-clock timeout; CPU/mem/process rlimits were left out (bwrap has no cgroup story without root — noted, not done). Verify on host — bwrap can't run nested in-session (`sandbox-userns-blocked-in-session`); the unit tests cover the cache/error logic via `unsafe_host` and gate the real-sandbox test on `sandbox.Available()`. **To check on host:** the #27 generator runs headless Chromium (Playwright) inside the userns sandbox; it already launches with `--no-sandbox` (so Chromium won't try to nest its own userns sandbox), but the full build → boot → screenshot path under bwrap is unverified here. If something can't initialise, prefer fixing the script over setting `unsafe_host`.

27. [x] **[Diff viewer]** Concrete artifact generator for Hydra's own home page (`scripts/screenshots/`, wired via `.hydra/config.toml` `[[artifacts]]`). Builds the checkout's frontend + a `hydra` binary, boots `hydra server --simulation` on a free port, and screenshots `/` with headless Chromium (Playwright). Output is made byte-reproducible (the runner compares versions by hashing bytes) by pinning Chromium font rendering (no GPU / no LCD-text / fixed hinting + sRGB) and freezing app animation (init script pins `Math.random` + the short typewriter timers; a stylesheet disables CSS animations/transitions). Per #26 it now runs inside the OS sandbox (was: on the host).
