# Hydra

Hydra is an AI orchestration platform designed to manage and run autonomous agents ("heads") in a project environment.
These agents are each run in an isolated Docker container, using Git worktrees to interact with the parent project.

It consists of a Go backend and a React frontend. The frontend is bundled into the binary, so it can be shipped as a
single binary.

```shellsession
$ hydra help
Hydra is an AI agent orchestrator.
It manages AI coding agents running in isolated Docker containers and git worktrees.

Usage:
  hydra [command]

Available Commands:
  attach       Attach to a running agent with the ID given
  completion   Generate the autocompletion script for the specified shell
  config       Manage project configuration
  help         Help about any command
  kill         Kill the head with the selected ID
  list         List all Hydra agents
  merge        Merge a head's changes into the current branch and kill it
  server       Run a web server
  spawn        Spawn a new AI agent for the given prompt
  tui          Open the interactive agent dashboard

Flags:
      --debug     Print full stack traces on error
  -h, --help      help for hydra
  -v, --version   version for hydra

Use "hydra [command] --help" for more information about a command.
```

## Getting Started

### Prerequisites

- [Go](https://go.dev/)
- [Docker](https://www.docker.com/)
- [Mage](https://magefile.org/)
- [Node.js](https://nodejs.org/) 24+ (for the frontend; runs the build scripts directly via its native TypeScript support)
- [npm](https://www.npmjs.com/) (ships with Node) or, optionally, [aube](https://github.com/jdx/aube) - see below

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

Run the development server (with restarting):
```bash
mage dev
```

Run the production server:
```bash
mage run
```

See `GEMINI.md`/`CLAUDE.md` for more instructions.

See `TODO.md` for limitations and a TODO list.

## Documentation

- [Diff Artifacts](docs/artifacts.md) — render screenshots and videos of a
  checkout and compare them across a diff (including `.webm` video diffing).
