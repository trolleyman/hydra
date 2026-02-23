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
mage build:all
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
