# Hydra

Hydra is an AI orchestration platform designed to manage and run autonomous agents ("heads") in a project environment.
Each agent runs in an isolated OS sandbox on its own Git worktree, so heads work in parallel without touching the parent
checkout or each other.

It consists of a Go backend and a React frontend. The frontend is bundled into the binary, so it can be shipped as a
single binary.

Hydra stores agent and conversation history in one user-scoped database shared
by CLI, browser-server, and desktop clients. Its native locations are
`$XDG_STATE_HOME/hydra/db.sqlite3` on Linux (falling back to
`~/.local/state/hydra`), `~/Library/Application Support/Hydra/db.sqlite3` on
macOS, and `%LOCALAPPDATA%\Hydra\db.sqlite3` on Windows. Project-local
`.hydra/local` directories continue to hold worktrees, caches, artifacts, logs,
and other project-specific runtime files.

```shellsession
$ hydra help
Hydra is an AI agent orchestrator.
It manages AI coding agents running in OS sandboxes and git worktrees.

Usage:
  hydra [command]

Available Commands:
  attach         Attach to a running agent with the ID given
  completion     Generate the autocompletion script for the specified shell
  config         Manage project configuration
  help           Help about any command
  host-run       Request the user's approval to run a command on the host (outside the sandbox)
  kill           Kill the head with the selected ID
  list           List all Hydra agents
  merge          Merge a head's changes into the current branch and kill it (unless --keep)
  server         Run a web server
  set-base       Change a head's base branch (metadata only; does not rebase commits)
  spawn          Spawn a new sandboxed AI agent for the given prompt
  tui            Open the interactive agent dashboard

Flags:
      --debug     Print full stack traces on error
  -h, --help      help for hydra
  -v, --version   version for hydra

Use "hydra [command] --help" for more information about a command.
```

## Platform support

- **Linux**: fully supported. Sandboxing uses bubblewrap (mount namespaces +
  seccomp), and hard network egress filtering uses pasta + nftables; Hydra
  provisions these helper binaries automatically (`mage tools:ensure`).
- **macOS**: builds and cross-compiles cleanly; the Seatbelt sandbox backend
  is partially implemented. See [docs/macos-support.md](docs/macos-support.md)
  for the audit and implementation plan.
- **Windows**: not yet supported natively (the binary builds; sandboxing and
  PTY sessions are stubbed). Running Hydra inside WSL2 works with the full
  Linux feature set. See [docs/windows-support.md](docs/windows-support.md)
  for the audit and implementation plan.

## Getting Started

### Prerequisites

- [Go](https://go.dev/)
- [Mage](https://magefile.org/)
- [Node.js](https://nodejs.org/) 24+ (for the frontend; runs the build scripts directly via its native TypeScript support)
- [npm](https://www.npmjs.com/) (ships with Node) or, optionally, [aube](https://github.com/jdx/aube) - see below
- Git

Building the experimental standalone Linux desktop shell additionally requires
GTK 4 and WebKitGTK 6 development files. On Ubuntu 24.04 and derivatives:

```bash
sudo apt install libwebkitgtk-6.0-dev
```

The frontend's package installs and `package.json` scripts run through **npm** by
default, since it ships with Node and needs no extra setup. If [aube](https://github.com/jdx/aube)
is on your `PATH`, `mage` uses it instead for a faster install - it reads and
writes the same `web/package-lock.json`, so the choice never affects the repo.
Any npm-compatible package manager (aube, pnpm, yarn, bun) works if you run the
web build by hand; only npm and aube are auto-detected.

### Running

Build the entire project (backend and frontend bundled in single `hydra` binary):
```bash
mage build
```

Run the server:
```bash
mage run
```

Build the experimental Linux desktop shell separately, then open a registered
project. It reuses the user-global daemon or starts the bundled backend:

```bash
go build -tags hydra_desktop -o hydra-desktop ./cmd/hydra-desktop
./hydra-desktop -project /path/to/project
```

The separate build keeps the normal `hydra` CLI free of GTK/WebKit runtime
dependencies. The project flag is optional; without it the app opens the global
service in Hydra's built-in Chat project. `-url http://127.0.0.1:<port>` remains
available for shell development. Ctrl+N opens another native window sharing the
same WebKit profile and backend. External HTTP(S) links open in the system
browser; cross-origin redirects and non-web schemes are blocked in the WebView.

Install it as a systemd --user service, so it comes up on login and survives
your terminal closing:
```bash
mage deploy:setup     # once - generates the auth key for non-localhost access
mage deploy:service
```

From then on the web UI's update button rebuilds and restarts the server for
you: it builds while the running server keeps serving, and only swaps the
binary once the build succeeds and the new one is proven to start. See
[docs/deployment.md](docs/deployment.md).

For frontend work, `mage devFast` runs Vite with hot-module-replacement in
front of the Go API, and `mage demo` does the same against mock data.

See `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` for more instructions.

## Documentation

- [Diff Artifacts](docs/artifacts.md) - render screenshots and videos of a
  checkout and compare them across a diff (including `.webm` video diffing).
- [Test gate](docs/testing.md) - per-project test runners, the tests panel,
  and how results gate merging.
- [Screenshots](docs/screenshots.md) - how the automated UI screenshot
  pipeline works and how to add a screenshot.
- [Agent page internals](docs/web-agent-page.md) - the diff viewer, sticky
  headers, and per-agent view state in the web UI.
- [Chat mode](docs/chat-mode.md) - how Claude and Codex chat-mode heads work:
  the normalized event log, the socket protocol, and how the chat renders.
- [macOS support](docs/macos-support.md) - darwin sandbox audit and plan.
- [Windows support](docs/windows-support.md) - Windows audit and plan.
