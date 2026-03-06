# syntax=docker/dockerfile:1
FROM hydra-base:latest

# Install Claude Code and make it available to all users.
RUN curl -fsSL https://claude.ai/install.sh | bash && \
    cp -L /root/.local/bin/claude /usr/local/bin/claude
