# syntax=docker/dockerfile:1
FROM ubuntu:24.04

# Install base utilities and helpful tools
RUN apt-get update && apt-get install -y \
        git \
        curl \
        wget \
        ca-certificates \
        gosu \
        ripgrep \
        jq \
        fd-find \
        tree \
        sudo \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

ENV DEVCONTAINER=true
ENV TERM=xterm-256color
ENV COLORTERM=truecolor

# Entrypoint: creates a matching host user at runtime, then exec's the command as that user.
# AGENT_UID, AGENT_GID, AGENT_USER, AGENT_GROUP, AGENT_HOME are passed as container env vars.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
