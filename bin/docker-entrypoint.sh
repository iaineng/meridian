#!/bin/sh
# Docker entrypoint:
# 1. Fix volume permissions (created as root, need claude ownership)
# 2. Symlink .claude.json into persistent volume
# 3. Copy host-mounted Claude binary if configured
# 4. Drop privileges to claude user via gosu

CLAUDE_DIR="/home/claude/.claude"
CLAUDE_JSON="/home/claude/.claude.json"
CLAUDE_JSON_VOL="$CLAUDE_DIR/.claude.json"

# Fix ownership if volume was created as root
if [ -d "$CLAUDE_DIR" ] && [ "$(stat -c %U "$CLAUDE_DIR" 2>/dev/null)" != "claude" ]; then
  echo "[entrypoint] Fixing volume permissions..."
  chown -R claude:claude "$CLAUDE_DIR"
fi

# Symlink .claude.json into volume so it persists across restarts.
# On first deploy the volume is empty and .claude.json doesn't exist yet,
# so we unconditionally ensure the symlink points into the volume.
# Writing through a dangling symlink creates the target file normally.
if [ -f "$CLAUDE_JSON" ] && [ ! -L "$CLAUDE_JSON" ]; then
  # Existing real file in container layer — migrate it into the volume
  cp "$CLAUDE_JSON" "$CLAUDE_JSON_VOL" 2>/dev/null
  rm -f "$CLAUDE_JSON"
fi
if [ ! -L "$CLAUDE_JSON" ]; then
  ln -sf "$CLAUDE_JSON_VOL" "$CLAUDE_JSON"
fi

# Ensure the volume file is owned by claude — it may have been
# created/copied by root (entrypoint runs as root before gosu).
if [ -f "$CLAUDE_JSON_VOL" ]; then
  chown claude:claude "$CLAUDE_JSON_VOL"
fi

# Copy host-mounted Claude binary into a PATH directory accessible to claude user.
# The host mount may be under /root/ (mode 700), so the claude user cannot traverse it.
# We resolve the symlink chain and copy the real binary to /usr/local/bin/.
if [ -n "$HOST_CLAUDE_PATH" ] && [ -e "$HOST_CLAUDE_PATH/bin/claude" ]; then
  CLAUDE_REAL=$(readlink -f "$HOST_CLAUDE_PATH/bin/claude")
  cp "$CLAUDE_REAL" /usr/local/bin/claude
  chmod 755 /usr/local/bin/claude
  echo "[entrypoint] Copied host Claude: $CLAUDE_REAL → /usr/local/bin/claude"
fi

# Drop privileges and exec CMD as claude user
exec gosu claude "$@"
