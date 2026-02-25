# syntax=docker/dockerfile:1
# Hydra Agent Dockerfile - Claude Code
#
# See: https://docs.anthropic.com/en/docs/claude-code

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
        sudo \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

ENV DEVCONTAINER=true

# Install Claude Code.
RUN curl -fsSL https://claude.ai/install.sh | bash

# Entrypoint: creates a matching host user at runtime, then exec's the command as that user.
# AGENT_UID, AGENT_GID, AGENT_USER, AGENT_GROUP, AGENT_HOME are passed as container env vars.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# # Install Go & tools
# RUN curl https://go.dev/dl/go1.26.0.linux-amd64.tar.gz -o go1.26.0.linux-amd64.tar.gz \
#     && tar -C /usr/local -xzf go1.26.0.linux-amd64.tar.gz \
#     && rm go1.26.0.linux-amd64.tar.gz \
#     && go install github.com/magefile/mage@latest

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
