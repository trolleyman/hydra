# Hydra

Hydra is an AI orchestration platform designed to manage and run autonomous agents ("Heads") in a project environment.

## Overview

Hydra manages:
- **Git Branches**: For project-specific work.
- **Git Worktrees**: For separate file environments.
- **Docker Containers**: To isolate and run agents.

## Getting Started

### Prerequisites

- [Go](https://go.dev/)
- [Docker](https://www.docker.com/)
- [Mise](https://mise.jdx.dev/) (recommended)
- [Mage](https://magefile.org/)
- [Bun](https://bun.sh/) (for frontend)

### Building

Build the entire project (backend and frontend):
```bash
mage build
```

Run the development server (with auto-rebuild):
```bash
mage dev
```

Or build and run in one command:
```bash
mage run
```

### Running

Launch the Hydra CLI and server:
```bash
go run ./
```
Or use the `mise` alias:
```bash
hydra
```

## Agent Support

Hydra supports the following agent types:
- **Claude**: Using `anthropic` credentials.
- **Gemini**: Using `google` oauth credentials.

See `GEMINI.md` for more developer instructions.

# TODO
- Add support for Copilot CLI
- Fix non-default dockerfiles to have Go installed correctly
- Install Go langauge server, as extension of above, so that Claude (/Gemini) can access language server information rather than just having to read files.
- Remove Console PTY is coming, as it's already implemented
- When console is connected, and agent is waiting, redraw somehow, as currently is just blank
- Test with Claude's native install (just changed)
- Fixup small issues with diff tool (wrap lines rather than scrollbar)
- Add a --force when merging / killing on the command line
- When merging / killing, move agent into that state and return some HTTP code saying it's doing something, then the button isn't disabled until then
- Move the project ID into the path, from the query
- Require a project ID, rather than defaulting to CWD
- When hydra attach is run:
    - if the docker container is stopped, run docker start -ai <containerID> claude --resume (unless it doesn't have a worktree and branch)
    - Also, dd an optional arg to hydra attach <id> [<command>] - instead of attaching to claude or anything, run that command. e.g. bash would exec bash in the container (-i), and run docker start <container> bash, if it was stopped.
- Use status_log.jsonl to provide better information on status, etc.
