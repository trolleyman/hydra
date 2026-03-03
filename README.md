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
- [Bun](https://bun.sh/) (for frontend)

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

See `GEMINI.md`/`CLAUDE.md` for more developer instructions.

See `TODO.md` for limitations and a TODO list.
