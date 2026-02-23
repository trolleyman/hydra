# Hydra Agent Dockerfile - Claude Code
#
# See: https://docs.anthropic.com/en/docs/claude-code

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y git curl gosu && rm -rf /var/lib/apt/lists/*

# Install Node.js 22.x
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

ENV DEVCONTAINER=true

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Write entrypoint script that creates a matching host user at runtime, then runs the command given as that user.
# AGENT_UID, AGENT_GID, AGENT_USER, AGENT_GROUP, AGENT_HOME are passed as container env vars.
RUN echo '#!/bin/bash' > /usr/local/bin/entrypoint.sh \
    && echo 'set -e' >> /usr/local/bin/entrypoint.sh \
    && echo 'groupadd -g "$AGENT_GID" "$AGENT_GROUP" 2>/dev/null || groupmod -n "$AGENT_GROUP" "$(getent group "$AGENT_GID" | cut -d: -f1)" 2>/dev/null || true' >> /usr/local/bin/entrypoint.sh \
    && echo 'useradd -u "$AGENT_UID" -g "$AGENT_GID" -m -d "$AGENT_HOME" -s /bin/bash "$AGENT_USER" 2>/dev/null || usermod -l "$AGENT_USER" -d "$AGENT_HOME" -m -g "$AGENT_GID" -s /bin/bash "$(getent passwd "$AGENT_UID" | cut -d: -f1)" 2>/dev/null || true' >> /usr/local/bin/entrypoint.sh \
    && echo 'chown "$AGENT_UID:$AGENT_GID" "$AGENT_HOME"' >> /usr/local/bin/entrypoint.sh \
    && echo 'exec gosu "$AGENT_USER" "$@"' >> /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
