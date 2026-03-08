# TODO
- [`diff-viewer-improvements`]
    - Make sure the warning about uncommitted changes is accurate - currently it is just always there if there are any changes, not just if there are uncommitted changes.
    - When loading, make the diffs become grayed out, not remove them altogether - as then there's less jumping around by a refresh. (refresh -> clear whole screen -> scroll move -> put diffs all back)
    - Organise changed files into folders, both in a tree structure and grouped by folder. Make this an option too - by default a tree. Also - for the other options - add them into a pop up settings (not dialog, don't freeze the whole screen). Add checkboxes for ignore whitespace, side by side, and one file at a time.
    - Add copy to clipboard function for paths.
    - ^DONE^?
    - TODO
        - Commits aren't refreshed after first load, but should be if the refresh button is pressed (or if a refresh is triggered by another way)
        - Make sidebar and header of current file sticky to the top of the screen - when scrolling down it should stick to the top, and the changed files should therefore be scrollable
        - Add a Comment button that will give the line and the comment you enter to the agent, once written and sent. This should be similar to GitLab's comment (but no intermediate review to cache to)
        - Add a button that can expand the diff up and down (it should be to the left of the diff header: `<expand down chevron> <expand up down chevron> <expand up chevron> @@ -3,7 +3,7 @@ import { api } from '../stores/apiClient'`) this should increase the lines seen by 5
        - Make the headers of a file able to collapse that file entirely
        - Make it a bit more performant - load the files diff first, then load the individual file (do this optimization if loading one-by-one, or if headers of a file are collapsed)
        - Make diff sidebar (changed files) size modifiable (draggable), and save that setting like the sidebar.
        - Remove copy filepath button from changed files diff sidebar, and instead add it to the filepath in the diff file header.
        - Fix 2 scroll bars issue when opening settings panel below agent terminal when diff is empty (No changes).

- Install Go langauge server, as extension of above, so that Claude (/Gemini) can access language server information rather than just having to read files.

- When merging / killing, move agent into that state and return some HTTP code saying it's doing something, then the button isn't disabled until then

- Move the project ID into the path, from the query
- Require a project ID, rather than defaulting to CWD (for most /api/ calls)

- When hydra attach is run:
    - if the docker container is stopped, run docker start -ai <containerID> claude --resume (unless it doesn't have a worktree and branch)
    - Also, dd an optional arg to hydra attach <id> [<command>] - instead of attaching to claude or anything, run that command. e.g. bash would exec bash in the container (-i), and run docker start <container> bash, if it was stopped.
- Use status_log.jsonl to provide better information on status, etc.

- Output of commands that are run is printed directly, could this also be prefixed with the log lines as normal, plus maybe `[stdout]` and `[stderr]` if possible? Also, don't store all stdout and stderr and print all at once, if the stdout and stderr of that command is interleaved, it should be interleaved in the log too.

# Recent
Tweak the diff viewer drop down - the left selector should be able to select "Latest commit", if the right selector is on latest changes. This combo should be selected when the uncommitted changes button is pressed. Also - the uncommitted changes button ruins the layout of the diff header - it creates a whole new line, and splits the left buttons from the right settings button. it shouldn't do this - possibly to do with the tooltip? Also - the left selector should have main at the bottom and the latest commit at the top. It should also forbid selecting a state that's the same as or after the right selector, same as the right selector shouldn't be able to select the same as or less than the left selector.

The expand lines buttons don't do anything in demo mode - can you get them to work? Might require adding a new API endpoint.

Fix the comment in the diff viewer - currently the add comment button is half hidden, as it's half outside the diff viewer, and overflow might be hidden? z-50 doesn't work to show it. When triggering, the comment also pops up a dialog that flickers in and out of visibility, opacity wise. Ctrl (cmd)+Enter doesn't add the comment. It should split the diff and add a comment text box in line with the rest of the diff, similar to GitLab. This way the user can see the diff and also the comment at the same time.
