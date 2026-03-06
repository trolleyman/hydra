Plan for Improving Hydra Config & UX
1. Hierarchical Configuration System
Goal: Replace hardcoded paths with a flexible, cascading configuration system.

Configuration Hierarchy:
Internal Defaults: Embedded in the application binary (fallback).
User Config: ~/.config/hydra/config.toml (Global settings for the user).
Project Config: <projectDir>/.hydra/config.toml (Project-specific overrides).
TOML Structure:

```toml
[defaults]
# Global defaults for all agents
dockerfile = "./Dockerfile" # Relative to the config file location
context = "."               # Build context directory (By default a temp dir in <projectDir>/.hydra/build (created with .dockerignore * and .gitignore *))
pre_prompt = "You are a helpful assistant." # See existing code for this

[agents.claude]
dockerfile = "claude.Dockerfile"
# Overrides for Claude specifically

[agents.gemini]
# Overrides for Gemini specifically
```

Implementation:
Create a config package to parse and merge these TOML files (when loading the config, load the dockerfiles)
Update SpawnAgent to accept a fully resolved configuration object instead of raw paths.
2. Docker User & Tooling Strategy
Goal: Allow installing tools (like Go, Node) during build time without knowing the runtime user's UID/GID.

Strategy:
Install Globally: In your Dockerfiles, install tools to global locations (e.g., /usr/local/bin, /usr/local/go). Do not install them into a specific user's home directory during the build.
Runtime User: The entrypoint.sh script (which you already have) creates the user at runtime to match the host's UID/GID. This ensures file permissions on mounted volumes are correct.
Skeleton Directory: If you need per-user config files (like .bashrc or .gitconfig), place them in /etc/skel in the Dockerfile. When useradd runs in the entrypoint, it will copy these to the new user's home directory.
Environment Variables: Use ENV in the Dockerfile to set GOPATH or PATH globally so they apply to any user.

3. UI & Ephemeral Agents
Goal: Enable configuration editing and testing within the Web UI.

API Endpoints:
GET /api/config: Retrieve the merged configuration.
POST /api/config: Save changes to the project or user config file.
Test Terminal:
Add a "Test" console in the settings UI.
Ephemeral: Add an Ephemeral flag to SpawnOptions. If true, the container is created with AutoRemove: true and explicitly killed when the WebSocket disconnects.
