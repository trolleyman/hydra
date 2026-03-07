# TODO
- Add the ability to open a bash terminal for the container - new tab? in the agent mode. This job would be killed once the WebSocket connection was closed.

- Diff viewer: Make sure the warning about uncommitted changes is accurate - currently it is just always there if there are any changes, not just if there are uncommitted changes.
- Diff viewer: When loading, make the diffs become grayed out, not remove them altogether - as then there's less jumping around by a refresh. (refresh -> clear whole screen -> scroll move -> put diffs all back)
- Diff viewer: Organise changed files into folders, both in a tree structure and grouped by folder. Make this an option too - by default a tree. Also - for the other options - add them into a pop up settings (not dialog, don't freeze the whole screen). Add checkboxes for ignore whitespace, side by side, and one file at a time.
- Diff viewer: Add copy to clipboard function for paths.

- Dockerfile syntax highlighting: these highlit dockerfiles on the settings page are always in light mode - fix for dark mode.

- [`copilot`] Add support for Copilot CLI

- [`terminal-clear-resize-help`] When opening up a terminal, the CLI agent doesn't know that the terminal has just changed, so it only sends incremental updates, meaning the screen is sometimes blank or only has some changes. When opening, send a resize event to make it a bit smaller, and then the actual size of the terminal, so that the view is refreshed and it accurately represents a terminal

- Install Go langauge server, as extension of above, so that Claude (/Gemini) can access language server information rather than just having to read files.
- When console is connected, and agent is waiting, redraw somehow, as currently is just blank
- When merging / killing, move agent into that state and return some HTTP code saying it's doing something, then the button isn't disabled until then
- Move the project ID into the path, from the query
- Require a project ID, rather than defaulting to CWD (for most /api/ calls)
- When hydra attach is run:
    - if the docker container is stopped, run docker start -ai <containerID> claude --resume (unless it doesn't have a worktree and branch)
    - Also, dd an optional arg to hydra attach <id> [<command>] - instead of attaching to claude or anything, run that command. e.g. bash would exec bash in the container (-i), and run docker start <container> bash, if it was stopped.
- Use status_log.jsonl to provide better information on status, etc.

- Output of commands that are run is printed directly, could this also be prefixed with the log lines as normal, plus maybe `[stdout]` and `[stderr]` if possible? Also, don't store all stdout and stderr and print all at once, if the stdout and stderr of that command is interleaved, it should be interleaved in the log too.
