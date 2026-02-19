# Hydra Agent Dockerfile — Gemini CLI
#
# The full task prompt is passed as an argument to this ENTRYPOINT.
# See: https://github.com/google-gemini/gemini-cli

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Gemini CLI
RUN npm install -g @google/gemini-cli

WORKDIR /app

ENTRYPOINT ["gemini", "code"]
