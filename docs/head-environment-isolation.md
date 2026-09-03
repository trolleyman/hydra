# Head environment isolation

Status: implemented.

Hydra builds each sandboxed head's environment from an allow-list. A daemon
started with `mage run` does not pass the launching terminal's unrelated
credentials, language runtime options, CI state, or Hydra daemon settings into
heads.

The filesystem follows the same default-deny model. Heads see their worktree,
private temporary and provider state, generated immutable inputs, Git metadata,
the system runtime/toolchain inventory, directories on their trusted `PATH`, and
the built-in or configured `readable_paths`. Linux constructs that view from an
empty bubblewrap namespace. macOS denies file reads in Seatbelt and appends the
same categories as explicit grants. Writable paths are inherently readable.

`masked_paths` remains a defense-in-depth deny list for known credential and
secret locations. Masks apply after every read and write grant, so allowing a
parent such as `~` does not expose a masked child. Project-relative masks and
`.hydraignore` continue to protect secrets inside otherwise readable worktrees.

An agent that needs one existing host file or directory outside this view can
call `mcp__hydra__request_read_access` with the path and a reason. Hydra resolves
the path on the host and shows the canonical target in an approval card. Allow
once records a per-head read-only grant; Always allow also adds the path to that
agent type's `readable_paths` in the trusted project config. Applying either
choice automatically rebuilds and resumes the sandbox. The per-head grant is
removed when the head is killed or archived, and `masked_paths` still wins over
both forms of grant.

## Policy

Head processes use an allow-list instead of inheriting the daemon environment.
The effective environment is assembled in this order, with later entries
overriding earlier ones:

1. A Hydra-owned baseline provides `HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`,
   `LANG`, `TERM`, `COLORTERM`, and private temporary-directory variables. At
   sandbox construction, Hydra also redirects XDG cache/state, Go build/module/
   workspace/output, Mage, npm, aube, Playwright, and mise cache/state variables
   beneath that sandbox's private temporary directory. `GOBIN` is prepended to
   `PATH`, so privately installed Go commands are usable in the same head.
   When mise's version-pinned launcher is installed, Hydra resolves its existing
   `MISE_INSTALL_PATH` offline so mise-backed agent shims reuse that read-only
   bootstrap executable instead of downloading mise into every new private data
   directory. Shared `~/.cache` and tool installation trees remain
   readable but are not writable by default. Git author and
   committer identity comes from the trusted project Git config.
2. A small provider-specific list preserves conventional direct authentication
   variables for only the selected agent type. Credentials for other providers
   are absent:

   - Claude: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
     `CLAUDE_CODE_OAUTH_TOKEN`
   - Codex: `OPENAI_API_KEY`
   - Gemini: `GEMINI_API_KEY`, `GOOGLE_API_KEY`
   - Copilot: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`

   Alternate cloud-provider modes and their associated variables are explicit
   `inherit_env` entries rather than expanding the built-in credential surface.
3. Trusted project config may opt names in from the daemon environment, for
   example:

   ```toml
   [claude.sandbox]
   inherit_env = ["ANDROID_HOME", "SSH_AUTH_SOCK"]
   ```

   These lists are additive across config layers. Missing host variables remain
   absent. Values do not appear in config or logs.
4. Hydra adds the per-head `HYDRA_*` context and internal control variables,
   including `HYDRA_BIN`, the immutable Hydra runtime path visible inside that
   head's sandbox.
5. The existing `pre_spawn_script` may append deliberate `KEY=value` entries to
   `$HYDRA_ENV`; those values continue to override the baseline on spawn and
   resume.

## Project-scoped caches

Projects can opt disposable caches into sharing across heads and sandboxed
runners. Each named entry owns a stable directory at
`<project-state>/cache/sandbox/<key>`:

```toml
[sandbox.cache]
go_build = { env = "GOCACHE" }
go_modules = { env = "GOMODCACHE" }
npm = { env = "npm_config_cache" }
generated = { path = "build/cache" }
```

An `env` entry replaces Hydra's private default for that variable. A `path`
entry creates a symlink at the worktree-relative path in a worktree or writable
project-directory workspace. The backing directory is already outside Git under
Hydra's local project state; the configured symlink path inside the repository
must also be ignored by Git. Since the repository entry is a symlink, a direct
ignore rule names it without a trailing slash (`build/cache`, not
`build/cache/`). Hydra checks that rule before creating the link,
rejects symlinked parent directories, and never replaces a file, directory, or
non-Hydra symlink at the target. If a cache key changes while retaining the same
path, Hydra updates the existing Hydra cache link. Read-only project-directory
workspaces do not materialize path caches. Cache keys merge across config layers,
with a later entry replacing the same key.

These directories are writable shared state. They are suitable for reproducible,
disposable caches, but not credentials, source-of-truth files, mutable executable
output, or per-worktree dependency trees. In particular:

- `GOCACHE`, `GOMODCACHE`, and Mage's cache can be shared; `GOPATH` and `GOBIN`
  remain private.
- npm's download cache can be shared; `node_modules` remains in its worktree or
  reusable artifact/test slot.
- `AUBE_CACHE_DIR` and its content-addressed `AUBE_STORE_DIR` can be shared;
  package installation state remains worktree-local.
- `MISE_CACHE_DIR` can be shared for downloads and metadata. `MISE_DATA_DIR` and
  `MISE_STATE_DIR` remain private because they contain installed executable and
  machine-local state. The mise launcher's resolved bootstrap executable remains
  available through `MISE_INSTALL_PATH`, and existing host tool installs are
  available through mise's read-only `MISE_SHARED_INSTALL_DIRS` search path.
- `PLAYWRIGHT_BROWSERS_PATH` can be shared for downloaded browser builds.

Hydra rejects invalid or managed names in `inherit_env`: all `HYDRA_*` names,
identity and command-resolution variables, temporary and generic XDG state
roots, agent runtime configuration, the mise bootstrap/trust contract, and HTTP
proxy variables used for egress enforcement. In particular, daemon settings
such as `HYDRA_STATE_DIR`, `HYDRA_API_ADDR`, and `HYDRA_BWRAP` never reach a
sandboxed head.

Application-specific cache and install variables are private defaults, not
hard restrictions. A trusted project may explicitly name variables such as
`GOCACHE`, `AUBE_CACHE_DIR`, `PLAYWRIGHT_BROWSERS_PATH`, or `MISE_DATA_DIR` in
`inherit_env`; an available daemon value then overrides the private default.
An explicit `sandbox.cache` entry has final precedence when the same variable is
configured both ways.

The first version preserves the daemon's `PATH` as an explicitly allowed value
because terminal launches, desktop launches, version managers, and locally
installed agent CLIs currently depend on it. Making `PATH` reproducible is a
separate tool-resolution change, not part of silently inheriting every variable.

## Scope

One shared environment builder supplies:

- normal agent spawn and resume;
- review agents;
- sandboxed head terminal tabs;
- sandboxed chat `!commands`;
- head `pre_spawn_script` and `pre_exit_script` processes.

Sandboxed chat `!commands` use the head's agent-type sandbox configuration,
shared caches, persisted `pre_spawn_script` environment, filesystem mode, and
Git-isolation mode. MCP servers and child processes naturally inherit the
agent's environment. The explicitly unsandboxed "Regular shell" keeps the host
environment. Test, artifact, preview, and service runners are separate because
their config trust and credential requirements differ from a head session.

On Linux, the outer `systemd-run --user` scope wrapper receives the daemon's
`XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` so it can contact the user
manager. Hydra restores the exact allow-listed workload environment with
`env -i` before starting the sandbox, so those host control variables do not
cross the head boundary.

## Implementation

- `SandboxConfig.InheritEnv` merges additively across trusted config layers and
  is exposed as `inherit_env` in Settings and the OpenAPI model.
- `heads.buildAgentEnv` is the pure allow-list builder. Hydra-generated seed,
  head-context, rendering, egress, and `$HYDRA_ENV` values are appended through
  their existing explicit channels.
- `sandbox.RuntimeEnv` maps temporary and mutable cache/state paths to the
  platform-visible private temp directory, except application variables a
  trusted project explicitly names in `inherit_env`. Linux uses its per-sandbox
  `/tmp`; macOS uses the protected real per-head or per-command directory.
- `sandbox.cache` selectively redirects cache variables or worktree paths to
  project-owned shared directories after those private defaults are applied.
- `SandboxConfig.ReadablePaths` merges additively across trusted config layers.
  The Linux and macOS backends combine it with their explicit system inventory;
  the shared option is path-based rather than mount-based so a Windows backend
  can enforce it with sandbox-principal ACL grants.
- Config decoding and saving reject Hydra-managed names before a head launches. The
  launch builder repeats that check defensively for programmatically assembled
  config values.
- Tests cover default denial, provider separation, explicit inheritance,
  reserved-name rejection, precedence, rendering, and config-layer merging.

## Rollout and verification

This is an intentional security boundary and has no broad "inherit everything"
compatibility switch. A project adds each nonstandard requirement deliberately
through `inherit_env` or produces a value from `pre_spawn_script` through
`$HYDRA_ENV`.
