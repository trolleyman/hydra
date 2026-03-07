# syntax=docker/dockerfile:1
FROM hydra-base:latest

# Install Node.js 22.x with apt cache mounts
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs

# Install Gemini CLI.
RUN npm install -g @google/gemini-cli
