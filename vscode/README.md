# Hydra for VS Code

Hydra provides profile-driven Claude Code and Codex conversations inside a
filesystem and network sandbox. This package is built from the main Hydra
repository; see `docs/vscode.md` there for architecture and development details.

Install dependencies with `aube install`. Aube consumes the committed
`package-lock.json`; it does not create a second lockfile. The scripts call local
Node entry points directly, so they do not depend on package-manager-specific
`.bin` links.

Use `aube run check` for generated types, TypeScript, and both bundles. Build the
native helper for the current platform with `aube run build:host`. Create a
platform-specific VSIX with `aube run package -- --target linux-x64` (also
`linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, and `win32-arm64`).
The VSIX contains a helper only for its declared target; Claude Code and Codex
remain external prerequisites and can be selected through the Hydra settings.
