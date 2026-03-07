FROM hydra-base:latest

# Install Node.js 22.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs

# Install GitHub Copilot CLI.
RUN npm install -g @github/copilot
