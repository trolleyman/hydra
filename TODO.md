# TODO
- Install Go langauge server, as extension of above, so that Claude (/Gemini) can access language server information rather than just having to read files.

- When merging / killing, move agent into that state and return some HTTP code saying it's doing something, then the button isn't disabled until then

- When hydra attach is run:
    - if the docker container is stopped, run docker start -ai <containerID> claude --resume (unless it doesn't have a worktree and branch)
    - Also, dd an optional arg to hydra attach <id> [<command>] - instead of attaching to claude or anything, run that command. e.g. bash would exec bash in the container (-i), and run docker start <container> bash, if it was stopped.
- Use status_log.jsonl to provide better information on status, etc.

- Output of commands that are run is printed directly, could this also be prefixed with the log lines as normal, plus maybe `[stdout]` and `[stderr]` if possible? Also, don't store all stdout and stderr and print all at once, if the stdout and stderr of that command is interleaved, it should be interleaved in the log too.

# Recent
No changes loaded shouldn't be the default state for short files - changes should be automatically loaded for short diffs (<1000 lines - and should come through the diff-files endpoint.) - I have to select Load diff for each file in the mage demo.

Tweak the diff viewer drop down - the left selector should be able to select "Latest commit", if the right selector is on latest changes. This combo should be selected when the uncommitted changes button is pressed. Also - the uncommitted changes button ruins the layout of the diff header - it creates a whole new line, and splits the left buttons from the right settings button. it shouldn't do this - possibly to do with the tooltip? Also - the left selector should have main at the bottom and the latest commit at the top. It should also forbid selecting a state that's the same as or after the right selector, same as the right selector shouldn't be able to select the same as or less than the left selector.

The expand lines buttons don't do anything in demo mode - can you get them to work? Might require adding a new API endpoint.

Fix the comment in the diff viewer - currently the add comment button is half hidden, as it's half outside the diff viewer, and overflow might be hidden? z-50 doesn't work to show it. When triggering, the comment also pops up a dialog that flickers in and out of visibility, opacity wise. Ctrl (cmd)+Enter doesn't add the comment. It should split the diff and add a comment text box in line with the rest of the diff, similar to GitLab. This way the user can see the diff and also the comment at the same time.
