# TODO
- Add the ability to open a bash terminal for the container - new tab? in the agent mode. This job would be killed once the WebSocket connection was closed.

- With diff viewer - Changes shouldn't also suddenly be Loading occasionally (timeout type thing) - it shouldn't reload automatically. This also reloads the terminal and everything. The terminal shouldn't reload on all status changes. Just when transitioning from `<anything but running/waiting> => <running/waiting>`
- In diff viewer - Save ignore whitespace, one file, other diff viewer settings. The refresh button should be moved to the left of the commit selector. The commit dropdown should be 2 buttons instead ([base/individidual commit selector] -> [individual commit selector/latest commit/latest changes]) commits should only be selected if they're valid (left should be before right, always)

- Add support for Copilot CLI

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
