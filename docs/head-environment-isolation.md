# Head environment isolation

Status: implemented.

Hydra builds each sandboxed head's environment from an allow-list. A daemon
started with `mage run` does not pass the launching terminal's unrelated
credentials, language runtime options, CI state, or Hydra daemon settings into
heads.

## Policy

Head processes use an allow-list instead of inheriting the daemon environment.
The effective environment is assembled in this order, with later entries
overriding earlier ones:

1. A Hydra-owned baseline provides `HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`,
   `LANG`, `TERM`, `COLORTERM`, and private temporary-directory variables. Git
   author and committer identity comes from the trusted project Git config.
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

Hydra rejects invalid or reserved names in `inherit_env`: all `HYDRA_*` names,
temporary-directory and identity variables, agent configuration variables, and
HTTP proxy variables that Hydra owns for egress enforcement. In particular,
daemon settings such as `HYDRA_STATE_DIR`, `HYDRA_API_ADDR`, and `HYDRA_BWRAP`
never reach a sandboxed head.

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

Sandboxed chat `!commands` also receive the environment persisted by the head's
`pre_spawn_script`. MCP servers and child processes naturally inherit the
agent's environment. The explicitly unsandboxed "Regular shell" keeps the host
environment. Test, artifact, preview, and service runners are separate because
their config trust and credential requirements differ from a head session.

## Implementation

- `SandboxConfig.InheritEnv` merges additively across trusted config layers and
  is exposed as `inherit_env` in Settings and the OpenAPI model.
- `heads.buildAgentEnv` is the pure allow-list builder. Hydra-generated seed,
  head-context, rendering, egress, and `$HYDRA_ENV` values are appended through
  their existing explicit channels.
- Config decoding and saving reject reserved names before a head launches. The
  launch builder repeats that check defensively for programmatically assembled
  config values.
- Tests cover default denial, provider separation, explicit inheritance,
  reserved-name rejection, precedence, rendering, and config-layer merging.

## Rollout and verification

This is an intentional security boundary and has no broad "inherit everything"
compatibility switch. A project adds each nonstandard requirement deliberately
through `inherit_env` or produces a value from `pre_spawn_script` through
`$HYDRA_ENV`.
