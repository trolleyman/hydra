# TODO
- Remove `Dockerfile Extension` hovering tooltip when editing Dockerfile
- Test terminal does not work on Windows - opening it doesn't transition it to the actual bash after building, for example. This is a problem as also when refreshing the terminal in the ephemeral test terminal on the settings page it deletes the agent

- Terminal sometimes has up to half a character mising at the bottom. Affected by resize-y, when resizing, this can get better / worse
- Terminal should copy if there is text selected and if ctrl + c is pressed. This should copy the text, and clear the selection. Ctrl+C should still send Ctrl+C when there is no selection on the terminal. Ctrl+V should also paste, not Ctrl+Shift+V. Use Ctrl+Shift+V to actually send Ctrl+V to the term.

- Make the Shared Mounts section in the settings page instead be a list rather than a comma separated system. Also it should show an example of the path that's shared in the container. If editing project settings the project dir should be the project dir, otherwise it should be e.g. `/home/<user>/project/.etc...`
- remove dockerfile path field from settings page
- make dockerfile contents and dockerignore contents fields taller, rename them to just dockerfile/dockerignore.
- tweak build context so that the logic follows shared mounts (absolute is absolute, ~ is relative to home, relative is relative to project dir. mentioin in info tooltip, refactor out info tooltip into shared component.) in this tooltip, show exact path it will be (if in user settings mode, show example project dir if needed)
- Text box under Dockerfile Contents can get 2 scroll bars (inner and outer - one with the FROM and one without, when expanding the resize anchor)

- Add the ability to open a bash terminal for the container - new tab? in the agent mode. This job would be killed once the WebSocket connection was closed.

- Syntax highlight Dockerfile as editing

- System pre-prompt is filled out even if it is just the default - fix this

- With diff viewer - Changes shouldn't also suddenly be Loading occasionally (timeout type thing) - it shouldn't reload automatically. This also reloads the terminal and everything. The terminal shouldn't reload on all status changes. Just when transitioning from `<anything but running/waiting> => <running/waiting>`

- In diff viewer - Save ignore whitespace, one file, other diff viewer settings. The refresh button should be moved to the left of the commit selector. The commit dropdown should be 2 buttons instead ([base/individidual commit selector] -> [individual commit selector/latest commit/latest changes]) commits should only be selected if they're valid (left should be before right, always)

- Based on `mage dev`, add `mage devFast` so that it runs the API on a different server, and that can be restarted, but the frontend is run as bun run dev. When the restart is clicked, this restarts both the backend and frontend servers. In mage dev mode, the hydra backend should only serve /api/ paths. It should serve it at a weird port number, and bun run dev should serve at 8080. This will mean that the frontend will update with any changes hot-reload style.

- Resize anchor when resizing can cause a transition which takes a while to complete (of system pre-prompt text box on the settings page)
- Add building state for terminal title bars when the agent is building, rather than the "stopped" state it's currently in.

- This error isn't shown in the terminal: (only `Building agent...` and `Step 1/8 : FROM debian:slim`. The error should be shown and the connection should be disconnected.)
```log
2026/03/07 00:44:45.699471 Building Docker image: hydra-base:latest (from C:\Users\ctoll\.hydra\default_dockerfiles\base\Dockerfile in C:\Users\ctoll\.hydra\default_dockerfiles\base)
2026/03/07 00:44:45.704734 [Building hydra-base:latest] Step 1/8 : FROM debian:slim
2026/03/07 00:44:45.704734 [Building hydra-base:latest]
2026/03/07 00:44:46.259502 error: background spawn agent test-bash-8h0z: ensure image: build default agent image: build base image: build error: failed to resolve reference "docker.io/library/debian:slim": docker.io/library/debian:slim: not found
```

Same here:
```log
2026/03/07 08:40:04.705291 [Building hydra-agent-claude-extended:2f399bfd] Successfully built 863a4259b2bb
2026/03/07 08:40:04.709622 [Building hydra-agent-claude-extended:2f399bfd] Successfully tagged hydra-agent-claude-extended:2f399bfd
2026/03/07 08:40:04.709622 Built Docker image: hydra-agent-claude-extended:2f399bfd (from C:\Users\ctoll\AppData\Local\Temp\hydra-build-1933415922\Dockerfile in C:\Users\ctoll\AppData\Local\Temp\hydra-build-1933415922)
2026/03/07 08:40:04.711183 Creating container hydra-agent-add-a-defaults-section-to-the-settings...
2026/03/07 08:40:04.711704 error: background spawn agent add-a-defaults-section-to-the-settings: create container: Error response from daemon: mount denied: the source path "/code_non_dev_drive/hydra/.git:C:/code_non_dev_drive/hydra/.git:rw" too many colons
```

Same here:
```log
2026/03/07 08:43:00.255491 [Building hydra-agent-claude-extended:2f399bfd]  ---> 863a4259b2bb
2026/03/07 08:43:00.258457 [Building hydra-agent-claude-extended:2f399bfd] Successfully built 863a4259b2bb
2026/03/07 08:43:00.263437 [Building hydra-agent-claude-extended:2f399bfd] Successfully tagged hydra-agent-claude-extended:2f399bfd
2026/03/07 08:43:00.263437 Built Docker image: hydra-agent-claude-extended:2f399bfd (from C:\Users\ctoll\AppData\Local\Temp\hydra-build-1132204294\Dockerfile in C:\Users\ctoll\AppData\Local\Temp\hydra-build-1132204294)
2026/03/07 08:43:00.298909 Creating container hydra-agent-add-a-defaults-section-to-the-settings...
2026/03/07 08:43:00.304666 error: background spawn agent add-a-defaults-section-to-the-settings: create container: Error response from daemon: the working directory 'C:\code_non_dev_drive\hydra\.hydra\worktrees\add-a-defaults-section-to-the-settings' is invalid, it needs to be an absolute path
```

Same here:
```log
2026/03/07 10:46:05.252685 [Building hydra-base:latest]  ---> Using cache
2026/03/07 10:46:05.252685 [Building hydra-base:latest]  ---> 1e850dff6be9
2026/03/07 10:46:05.252685 [Building hydra-base:latest] Step 3/9 : RUN --mount=type=cache,target=/var/cache/apt,sharing=locked     --mount=type=cache,target=/var/lib/apt,sharing=locked     apt-get update && apt-get install -y         git         curl         wget         ca-certificates         gosu         ripgrep         jq         fd-find         tree         sudo         build-essential         procps         psmisc         lsb-release         gnupg     && ln -s /usr/bin/fdfind /usr/local/bin/fd
2026/03/07 10:46:05.253214 [Building hydra-base:latest]
2026/03/07 10:46:05.255475 $ git -C C:/code_non_dev_drive/hydra branch -D main
2026/03/07 10:46:05.257630 error: background spawn agent test-bash-1jp3: ensure image: build default agent image: build base image: build error: the --mount option requires BuildKit. Refer to https://docs.docker.com/go/buildkit/ to learn how to build images with BuildKit enabled
error: cannot delete branch 'main' used by worktree at 'C:/code_non_dev_drive/hydra'
```

Same here:
```log
2026/03/07 11:01:35.810719 [Building hydra-agent-gemini:latest]  ---> f10a1b0c23ad
2026/03/07 11:01:35.813929 [Building hydra-agent-gemini:latest] Successfully built f10a1b0c23ad
2026/03/07 11:01:35.833952 [Building hydra-agent-gemini:latest] Successfully tagged hydra-agent-gemini:latest
2026/03/07 11:01:35.833952 Built Docker image: hydra-agent-gemini:latest (from C:\Users\ctoll\.hydra\default_dockerfiles\gemini\Dockerfile in C:\Users\ctoll\.hydra\default_dockerfiles\gemini)
2026/03/07 11:01:35.834479 Building Docker image: hydra-agent-gemini-extended:20418a26 (from C:\Users\ctoll\AppData\Local\Temp\hydra-build-102201914\Dockerfile in C:\code_non_dev_drive\hydra\.hydra\build\tmp)
2026/03/07 11:01:35.839866 error: background spawn agent terminal-show-error: ensure image: build image: Error response from daemon: forbidden path outside the build context: ../../../../../Users/ctoll/AppData/Local/Temp/hydra-build-102201914/Dockerfile ()
```

- Hydra tries to delete main worktree when the ephemeral test agents are deleted (when closing the test terminal window):
```log
2026/03/07 00:48:49.143752 $ git -C C:/code_non_dev_drive/hydra branch -D main
error: cannot delete branch 'main' used by worktree at 'C:/code_non_dev_drive/hydra'
2026/03/07 00:48:49.164043 warn: delete branch main: git branch -D: exit status 1
2026/03/07 00:48:49.168133 DELETE /api/agent/test-bash-8h0z 204 44ms
```

- Add support for Copilot CLI

- Install Go langauge server, as extension of above, so that Claude (/Gemini) can access language server information rather than just having to read files.
- When console is connected, and agent is waiting, redraw somehow, as currently is just blank
- Test with Claude's native install (just changed)
- Add a --force when merging / killing on the command line
- When merging / killing, move agent into that state and return some HTTP code saying it's doing something, then the button isn't disabled until then
- Move the project ID into the path, from the query
- Require a project ID, rather than defaulting to CWD (for most /api/ calls)
- When hydra attach is run:
    - if the docker container is stopped, run docker start -ai <containerID> claude --resume (unless it doesn't have a worktree and branch)
    - Also, dd an optional arg to hydra attach <id> [<command>] - instead of attaching to claude or anything, run that command. e.g. bash would exec bash in the container (-i), and run docker start <container> bash, if it was stopped.
- Use status_log.jsonl to provide better information on status, etc.

- Output of commands that are run is printed directly, could this also be prefixed with the log lines as normal, plus maybe `[stdout]` and `[stderr]` if possible? Also, don't store all stdout and stderr and print all at once, if the stdout and stderr of that command is interleaved, it should be interleaved in the log too.
