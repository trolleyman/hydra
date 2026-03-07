FROM debian:stable-slim

# Install base utilities and helpful tools
ARG DEBIAN_FRONTEND=noninteractive
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
        procps \
        psmisc \
        lsb-release \
        gnupg \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd

ENV DEVCONTAINER=true
ENV TERM=xterm-256color
ENV COLORTERM=truecolor

# Entrypoint: creates a matching host user at runtime, then exec's the command as that user.
# AGENT_UID, AGENT_GID, AGENT_USER, AGENT_GROUP, AGENT_HOME are passed as container env vars.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
