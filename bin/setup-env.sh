#!/bin/bash
# One-click environment setup: install Docker + gVisor.
#
# Usage:
#   sudo ./bin/setup-env.sh
#
# Prerequisites: Debian/Ubuntu system with curl installed.
# Idempotent — safe to re-run; skips components already installed.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Preflight ────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "Error: This script must be run as root (use sudo)."
  exit 1
fi

echo "==========================================="
echo "  Meridian Environment Setup"
echo "==========================================="
echo ""

# ── Step 1: Install Docker ───────────────────────────────────────
if command -v docker > /dev/null 2>&1; then
  DOCKER_VERSION=$(docker --version 2>/dev/null || echo "unknown")
  echo "  [1/2] Docker already installed: $DOCKER_VERSION"
  echo "         Skipping Docker installation."
else
  echo "  [1/2] Installing Docker..."
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh

  # Enable and start Docker service
  systemctl enable docker
  systemctl start docker

  echo "  Docker installed: $(docker --version)"

  # Brief cooldown to let the Docker service settle before the next step
  sleep 1
fi

echo ""

# ── Step 2: Install gVisor ───────────────────────────────────────
if command -v runsc > /dev/null 2>&1; then
  RUNSC_VERSION=$(runsc --version 2>/dev/null | head -1 || echo "unknown")
  echo "  [2/2] gVisor already installed: $RUNSC_VERSION"
  echo "         Skipping gVisor installation."
else
  echo "  [2/2] Installing gVisor..."
  bash "$SCRIPT_DIR/install-gvisor.sh"
fi

echo ""
echo "==========================================="
echo "  Environment setup complete!"
echo ""
echo "  Docker: $(docker --version 2>/dev/null || echo 'not found')"
echo "  gVisor: $(runsc --version 2>/dev/null | head -1 || echo 'not found')"
echo ""
echo "  Next step:"
echo "    ./bin/deploy.sh --id 0    # deploy default instance"
echo "==========================================="
