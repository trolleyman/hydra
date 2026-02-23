"""

Add a config command CLI to generate and put the default Dockerfiles (and required files, namely entrypoint.sh), in <projectDir>/.hydra/config/{gemini,claude}/ which can then be modified to edit the default dockerfiles for these agents - config.go should handle this, by checking if they exist and using them as the dockerfile path (ensureImageCustom)

"""

When hydra attach is run:
  - if the docker container is stopped, run docker start -ai <containerID> claude --resume (unless it doesn't have a worktree and branch). Add an optional arg to hydra attach <id> [<command>] - instead of attaching to claude or anything, run that command. e.g. bash would exec bash in the container (-i), and run docker start <container> bash, if it was stopped.

"""

Add default "pending" state for claude and gemini. Also - make it generic for gemini as well. Change the existing "Status" to just be the container status. (see cmd list.go). Also - make Gemini also ping back status updates like Claude, using Gemini hooks. See https://geminicli.com/docs/hooks/ We want SessionEnd, SessionStart, AfterAgent. Also - update the status so that it is updated when it's polled that the container is exited (stopped), the status should be "exited". Add a list of statuses that can be set in the openapi.yaml file - then use the generated code instead of raw literals everywhere (apart from hydra-status.sh, as that's a raw .sh nodejs script.)

"""

Add GEMINI.md and CLAUDE.md

"""