# syntax=docker/dockerfile:1
FROM hydra-base:latest

# Install Node.js 22.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code and make it available to all users.
RUN curl -fsSL https://claude.ai/install.sh | bash && \
    cp -L /root/.local/bin/claude /usr/local/bin/claude
