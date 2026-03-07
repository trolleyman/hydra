#!/bin/bash
set -e

# Create a group matching the host GID, or rename the existing one.
groupadd -g "$AGENT_GID" "$AGENT_GROUP" 2>/dev/null \
    || groupmod -n "$AGENT_GROUP" "$(getent group "$AGENT_GID" | cut -d: -f1)" 2>/dev/null \
    || true

# Create a user matching the host UID/GID, or rename the existing one.
useradd -u "$AGENT_UID" -g "$AGENT_GID" -m -d "$AGENT_HOME" -s /bin/bash "$AGENT_USER" 2>/dev/null \
    || usermod -l "$AGENT_USER" -d "$AGENT_HOME" -m -g "$AGENT_GID" -s /bin/bash \
        "$(getent passwd "$AGENT_UID" | cut -d: -f1)" 2>/dev/null \
    || true

chown "$AGENT_UID:$AGENT_GID" "$AGENT_HOME"

# Add the user to the sudo group and allow passwordless sudo.
usermod -aG sudo "$AGENT_USER"
echo "$AGENT_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/"$AGENT_USER"
chmod 0440 /etc/sudoers.d/"$AGENT_USER"

# Allow git to operate in mounted directories regardless of ownership.
# This is required when running on Windows hosts where mounted NTFS volumes
# may report ownership that doesn't match the container user.
git config --system --add safe.directory '*'

exec gosu "$AGENT_USER" "$@"
