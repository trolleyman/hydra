# syntax=docker/dockerfile:1
# Hydra Agent Dockerfile - Gemini CLI
#
# See: https://github.com/google-gemini/gemini-cli

FROM ubuntu:24.04

# Install base utilities and helpful tools
RUN apt-get update && apt-get install -y \
        git \
        curl \
        gosu \
        ripgrep \
        jq \
        fd-find \
        tree \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

ENV DEVCONTAINER=true

# Install Gemini CLI.
# The cache mount keeps the npm download cache across image rebuilds.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @google/gemini-cli

# Entrypoint: creates a matching host user at runtime, then exec's the command as that user.
# AGENT_UID, AGENT_GID, AGENT_USER, AGENT_GROUP, AGENT_HOME are passed as container env vars.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
