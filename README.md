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
- Make agents not start with an unknown agent type
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

- Fix issue: `2026/02/28 12:05:04.822656 terminal ws: attach container "": invalid container name or ID: value is empty` - this is the log when the terminal tries to connect when either stopped, or building (any state but running (check this)) - it should detect this and instead give a readonly docker log look at the head. This could maybe be done all on the API side? Not sure. This will at least require some changes to the web UI

## Logging
Improve logging of docker image building - make the logs have a prefix (`[build <container name>] <log line>`), currently it's this instead (all output is logged, plus some lines don't have the log line prefix entirely, and it's confusing what's the image building and what's not)

```
2026/02/28 11:34:30.676557 Building Docker image: hydra-agent-claude:c456b31e (from /Users/callumtolley/code/hydra/.hydra/config/claude/Dockerfile in /Users/callumtolley/code/hydra/.hydra/config/claude)
2026/02/28 11:34:30.686853 Step 1/7 : FROM ubuntu:24.04
2026/02/28 11:34:30.686914
2026/02/28 11:34:30.757953 terminal ws: attach container "": invalid container name or ID: value is empty
2026/02/28 11:34:30.758058 GET /ws/agent/copilot-cli/terminal 200 25ms
2026/02/28 11:34:30.774400 GET /api/agent/copilot-cli/commits 200 40ms
2026/02/28 11:34:30.774685 GET /api/agent/copilot-cli/diff 200 40ms
2026/02/28 11:34:31.219457 GET /api/agents 200 18ms
2026/02/28 11:34:36.201407 GET /api/status 200 0s
2026/02/28 11:34:36.204340 GET /api/projects 200 0s
2026/02/28 11:34:36.221180 GET /api/agents 200 20ms
2026/02/28 11:34:41.219204 GET /api/agents 200 18ms
2026/02/28 11:34:46.201360 GET /api/status 200 0s
2026/02/28 11:34:46.203914 GET /api/projects 200 0s
2026/02/28 11:34:46.220790 GET /api/agents 200 20ms
2026/02/28 11:34:51.219075 GET /api/agents 200 18ms
2026/02/28 11:34:52.990898  ---> d1e2e92c075e
2026/02/28 11:34:52.990953 Step 2/7 : RUN apt-get update && apt-get install -y         git         curl         gosu         ripgrep         jq         fd-find         tree         sudo         build-essential     && rm -rf /var/lib/apt/lists/*
2026/02/28 11:34:52.990971
2026/02/28 11:34:53.160224  ---> Running in 6563e205439f
2026/02/28 11:34:53.606566 Get:1 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]
2026/02/28 11:34:53.614742 Get:2 http://archive.ubuntu.com/ubuntu noble InRelease [256 kB]
2026/02/28 11:34:53.928031 Get:3 http://security.ubuntu.com/ubuntu noble-security/main amd64 Packages [1883 kB]
2026/02/28 11:34:53.938687 Get:4 http://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]
2026/02/28 11:34:54.251066 Get:5 http://archive.ubuntu.com/ubuntu noble-backports InRelease [126 kB]
2026/02/28 11:34:54.572111 Get:6 http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages [19.3 MB]
2026/02/28 11:34:56.201098 GET /api/status 200 0s
2026/02/28 11:34:56.203899 GET /api/projects 200 0s
2026/02/28 11:34:56.219555 GET /api/agents 200 19ms
2026/02/28 11:34:56.242299 Get:7 http://security.ubuntu.com/ubuntu noble-security/universe amd64 Packages [1242 kB]
2026/02/28 11:34:57.914788 Get:8 http://security.ubuntu.com/ubuntu noble-security/multiverse amd64 Packages [34.8 kB]
2026/02/28 11:34:58.005856 Get:9 http://security.ubuntu.com/ubuntu noble-security/restricted amd64 Packages [3262 kB]
2026/02/28 11:35:01.218337 GET /api/agents 200 18ms
2026/02/28 11:35:06.200439 GET /api/status 200 0s
2026/02/28 11:35:06.202920 GET /api/projects 200 0s
2026/02/28 11:35:06.219240 GET /api/agents 200 19ms
2026/02/28 11:35:09.290047 Get:10 http://archive.ubuntu.com/ubuntu noble/main amd64 Packages [1808 kB]
2026/02/28 11:35:10.422305 Get:11 http://archive.ubuntu.com/ubuntu noble/restricted amd64 Packages [117 kB]
2026/02/28 11:35:10.423869 Get:12 http://archive.ubuntu.com/ubuntu noble/multiverse amd64 Packages [331 kB]
2026/02/28 11:35:10.590144 Get:13 http://archive.ubuntu.com/ubuntu noble-updates/universe amd64 Packages [2017 kB]
2026/02/28 11:35:11.219400 GET /api/agents 200 18ms
2026/02/28 11:35:11.757154 Get:14 http://archive.ubuntu.com/ubuntu noble-updates/restricted amd64 Packages [3471 kB]
2026/02/28 11:35:11.835299 GET / 200 0s
2026/02/28 11:35:11.854630 GET /assets/index-Dqj_ICRP.js 200 0s
2026/02/28 11:35:11.854759 GET /assets/index-DajHYMfA.css 200 0s
2026/02/28 11:35:11.862479 GET /site.webmanifest 200 0s
2026/02/28 11:35:11.892543 GET /assets/routes-BrP-ENHg.css 200 0s
2026/02/28 11:35:11.896773 GET /assets/routes-B374Z83l.js 200 4ms
2026/02/28 11:35:11.902773 GET /favicon-32x32.png 200 0s
2026/02/28 11:35:11.975283 GET /icon.png 200 0s
2026/02/28 11:35:11.981564 GET /api/status 200 0s
2026/02/28 11:35:11.987334 GET /api/projects 200 0s
2026/02/28 11:35:12.004324 GET /api/agents 200 23ms
2026/02/28 11:35:12.059720 terminal ws: attach container "": invalid container name or ID: value is empty
2026/02/28 11:35:12.059834 GET /ws/agent/copilot-cli/terminal 200 24ms
2026/02/28 11:35:12.075646 GET /api/agent/copilot-cli/commits 200 38ms
2026/02/28 11:35:12.077910 GET /api/agent/copilot-cli/diff 200 40ms
2026/02/28 11:35:14.115256 Get:15 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 Packages [2275 kB]
2026/02/28 11:35:15.670577 Get:16 http://archive.ubuntu.com/ubuntu noble-updates/multiverse amd64 Packages [38.1 kB]
2026/02/28 11:35:15.690358 Get:17 http://archive.ubuntu.com/ubuntu noble-backports/main amd64 Packages [49.5 kB]
2026/02/28 11:35:15.719430 Get:18 http://archive.ubuntu.com/ubuntu noble-backports/universe amd64 Packages [34.6 kB]
2026/02/28 11:35:15.767559 Fetched 36.5 MB in 22s (1635 kB/s)
Reading package lists...
2026/02/28 11:35:17.000953 GET /api/agents 200 19ms
2026/02/28 11:35:17.070786
2026/02/28 11:35:17.115502 Reading package lists...
2026/02/28 11:35:18.353059
2026/02/28 11:35:18.373157 Building dependency tree...
2026/02/28 11:35:18.616653
```

Also in the log is this:
```
2026/02/28 11:34:30.523381 $ git -C /Users/callumtolley/code/hydra worktree add -b hydra/copilot-cli /Users/callumtolley/code/hydra/.hydra/worktrees/copilot-cli main
Preparing worktree (new branch 'hydra/copilot-cli')
HEAD is now at 6ca17c4 Update readme
```

- Output of commands that are run is printed directly, could this also be prefixed with the log lines as normal, plus maybe `[stdout]` and `[stderr]` if possible? Also, don't store all stdout and stderr and print all at once, if the stdout and stderr of that command is interleaved, it should be interleaved in the log too.
