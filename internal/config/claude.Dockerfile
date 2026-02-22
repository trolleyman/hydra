# Hydra Agent Dockerfile — Claude Code
#
# The full task prompt is passed as an argument to this ENTRYPOINT.
# See: https://docs.anthropic.com/en/docs/claude-code

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

ENTRYPOINT ["claude", "--dangerously-skip-permissions", "--"]
