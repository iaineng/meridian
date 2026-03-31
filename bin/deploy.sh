#!/bin/bash
# Self-contained Docker deployment script.
#
# Builds the proxy image with Claude Code installed inside the container
# (no host-side Claude installation required), then drops the user into
# an interactive shell for `claude login`, and finally starts the proxy
# in daemon mode.
#
# Auth credentials are persisted in a Docker volume so they survive
# container restarts. Re-run with --auth to re-authenticate without
# rebuilding.
#
# Usage:
#   ./bin/deploy.sh              # full build + auth + run (default instance)
#   ./bin/deploy.sh --id 2       # instance #2 → port 3458, container claude-max-proxy-2
#   ./bin/deploy.sh --upgrade    # rebuild image + restart (skip auth — for code/SDK updates)
#   ./bin/deploy.sh --auth       # re-auth only (skip build, restart proxy)
#   ./bin/deploy.sh --no-build   # skip build, auth + run
#   ./bin/deploy.sh --proxy http://host:port          # use HTTP proxy
#   ./bin/deploy.sh --proxy socks5://host:port        # use SOCKS5 proxy
#   ./bin/deploy.sh --proxy http://host:port --no-proxy "localhost,127.0.0.1"
#   ./bin/deploy.sh --id 3 --auth                     # re-auth instance #3
#   ./bin/deploy.sh --id 1 --upgrade                  # upgrade instance #1
#
# Instance numbering (--id N):
#   Omitted / 0 → default instance (port 3456, container claude-max-proxy)
#   1           → port 3457, container claude-max-proxy-1, volume claude-max-proxy-1-auth
#   2           → port 3458, container claude-max-proxy-2, volume claude-max-proxy-2-auth
#   ...and so on. Each instance has its own volume and container.
#
# Environment variables:
#   MERIDIAN_PORT    Host port to expose (default: 3456, added by --id N)
#   IMAGE_NAME           Docker image name (default: claude-max-proxy)
#   CONTAINER_NAME       Docker container name (default: claude-max-proxy[-N])
#   HTTP_PROXY           HTTP proxy (overridden by --proxy flag)
#   HTTPS_PROXY          HTTPS proxy (overridden by --proxy flag)
#   ALL_PROXY            SOCKS5 proxy (overridden by --proxy flag)
#   NO_PROXY             Proxy bypass list (overridden by --no-proxy flag)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
cd "$PROJECT_DIR"

SKIP_BUILD=false
AUTH_ONLY=false
SKIP_AUTH=false
NETWORK_PROXY=""
NETWORK_NO_PROXY=""
INSTANCE_ID=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)
      INSTANCE_ID="$2"
      if ! [[ "$INSTANCE_ID" =~ ^[0-9]+$ ]]; then
        echo "Error: --id requires a non-negative integer, got '$INSTANCE_ID'"
        exit 1
      fi
      shift 2
      ;;
    --upgrade)   SKIP_AUTH=true; shift ;;
    --auth)      AUTH_ONLY=true; SKIP_BUILD=true; shift ;;
    --no-build)  SKIP_BUILD=true; shift ;;
    --proxy)
      NETWORK_PROXY="$2"; shift 2 ;;
    --no-proxy)
      NETWORK_NO_PROXY="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --id N                Instance number (0 or omitted = default instance)"
      echo "                        Each ID gets its own port, container, and volume"
      echo "  --upgrade             Rebuild image + restart container (skip auth)"
      echo "                        Use after code changes or SDK version bumps"
      echo "  --auth                Re-authenticate only (skip build, restart proxy)"
      echo "  --no-build            Skip Docker image build"
      echo "  --proxy URL           HTTP/SOCKS5 proxy (e.g. http://host:port, socks5://host:port)"
      echo "  --no-proxy LIST       Comma-separated proxy bypass list"
      echo "  --help                Show this help"
      echo ""
      echo "Examples:"
      echo "  $0                    # default instance → port 3456"
      echo "  $0 --id 1            # instance 1 → port 3457"
      echo "  $0 --upgrade          # rebuild + restart (code/SDK update)"
      echo "  $0 --id 2 --upgrade  # upgrade instance 2"
      echo "  $0 --id 2 --auth     # re-auth instance 2"
      echo ""
      echo "Environment variables:"
      echo "  MERIDIAN_PORT    Base port (default: 3456), offset by --id N"
      echo "  HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY"
      echo "  These are overridden by the --proxy / --no-proxy flags."
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ── Derive names from instance ID ───────────────────────────────
BASE_IMAGE="${IMAGE_NAME:-claude-max-proxy}"
BASE_PORT="${MERIDIAN_PORT:-3456}"

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "0" ]; then
  # Default instance — fully backward-compatible
  IMAGE_NAME="$BASE_IMAGE"
  CONTAINER_NAME="${CONTAINER_NAME:-claude-max-proxy}"
  PORT="$BASE_PORT"
else
  IMAGE_NAME="$BASE_IMAGE"
  CONTAINER_NAME="${CONTAINER_NAME:-claude-max-proxy-${INSTANCE_ID}}"
  PORT=$((BASE_PORT + INSTANCE_ID))
fi

AUTH_VOLUME="${CONTAINER_NAME}-auth"
SESSION_VOLUME="${CONTAINER_NAME}-sessions"

echo "==========================================="
echo "  Instance config"
echo "    ID:        ${INSTANCE_ID:-default}"
echo "    Container: $CONTAINER_NAME"
echo "    Volumes:   $AUTH_VOLUME (auth), $SESSION_VOLUME (sessions)"
echo "    Port:      $PORT"
echo "==========================================="
echo ""

# Resolve proxy settings: flags > environment variables > empty
NETWORK_PROXY="${NETWORK_PROXY:-${ALL_PROXY:-${HTTPS_PROXY:-${HTTP_PROXY:-}}}}"
NETWORK_NO_PROXY="${NETWORK_NO_PROXY:-${NO_PROXY:-}}"

# ── Inherit proxy settings from existing container (upgrade mode) ──
# When upgrading, if no --proxy was explicitly passed, read the proxy
# config from the running container so the user doesn't have to repeat it.
if [ "$SKIP_AUTH" = true ] && [ -z "$NETWORK_PROXY" ]; then
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    INHERITED_PROXY=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | grep -m1 "^ALL_PROXY=" | cut -d= -f2-)
    if [ -n "$INHERITED_PROXY" ]; then
      NETWORK_PROXY="$INHERITED_PROXY"
      echo "  Inherited proxy from existing container: $NETWORK_PROXY"
    fi
    INHERITED_NO_PROXY=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | grep -m1 "^NO_PROXY=" | cut -d= -f2-)
    if [ -n "$INHERITED_NO_PROXY" ]; then
      NETWORK_NO_PROXY="$INHERITED_NO_PROXY"
      echo "  Inherited no-proxy from existing container: $NETWORK_NO_PROXY"
    fi
  fi
fi

# Build proxy env vars — only applied to the final running container
PROXY_RUN_ENVS=()
if [ -n "$NETWORK_PROXY" ]; then
  echo "  Network proxy (runtime only): $NETWORK_PROXY"
  PROXY_RUN_ENVS+=(
    -e "HTTP_PROXY=$NETWORK_PROXY"
    -e "HTTPS_PROXY=$NETWORK_PROXY"
    -e "ALL_PROXY=$NETWORK_PROXY"
    -e "http_proxy=$NETWORK_PROXY"
    -e "https_proxy=$NETWORK_PROXY"
    -e "all_proxy=$NETWORK_PROXY"
  )
fi
if [ -n "$NETWORK_NO_PROXY" ]; then
  echo "  No-proxy list: $NETWORK_NO_PROXY"
  PROXY_RUN_ENVS+=(
    -e "NO_PROXY=$NETWORK_NO_PROXY"
    -e "no_proxy=$NETWORK_NO_PROXY"
  )
fi

# ── Step 1: Build ─────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "==========================================="
  echo "  [1/3] Building Docker image..."
  echo "==========================================="
  docker build -f Dockerfile.deploy -t "$IMAGE_NAME" .
  echo ""
  echo "  Build complete."
  echo ""
else
  echo "==========================================="
  echo "  [1/3] Build skipped."
  echo "==========================================="
  echo ""
fi

# Verify image exists
if ! docker image inspect "$IMAGE_NAME" > /dev/null 2>&1; then
  echo "Error: Image '$IMAGE_NAME' not found. Run without --no-build first."
  exit 1
fi

# ── Step 2: Interactive auth ──────────────────────────────────
if [ "$SKIP_AUTH" = true ]; then
  echo "==========================================="
  echo "  [2/3] Auth skipped (--upgrade mode)."
  echo "==========================================="

  # Verify existing auth is still valid
  echo "  Verifying existing authentication..."
  AUTH_CHECK=$(docker run --rm \
    -v "$AUTH_VOLUME:/home/claude/.claude" \
    "${PROXY_RUN_ENVS[@]}" \
    "$IMAGE_NAME" \
    claude auth status 2>&1) || true

  if echo "$AUTH_CHECK" | grep -q '"loggedIn": true'; then
    EMAIL=$(echo "$AUTH_CHECK" | grep -o '"email": "[^"]*"' | head -1 | sed 's/"email": "//;s/"//')
    echo "  Authenticated as: $EMAIL"
  else
    echo ""
    echo "  Warning: Existing auth may be expired."
    echo "  If the proxy fails, re-run with --auth to re-authenticate."
    echo ""
  fi
else
  echo "==========================================="
  echo "  [2/3] Claude authorization"
  echo "==========================================="
  echo ""
  echo "  Entering container shell..."
  echo "  Please run:  claude login"
  echo "  After authorization, type 'exit' to continue."
  echo ""

  # Pre-create symlink so `claude login` writes .claude.json into the
  # persistent volume (via symlink) instead of the ephemeral container layer.
  # This ensures device_id survives container restarts.
  docker run -it --rm \
    -v "$AUTH_VOLUME:/home/claude/.claude" \
    "${PROXY_RUN_ENVS[@]}" \
    --entrypoint sh \
    "$IMAGE_NAME" \
    -c 'ln -sf /home/claude/.claude/.claude.json /home/claude/.claude.json; exec bash'

  # Quick sanity check: verify auth succeeded
  echo ""
  echo "  Verifying authentication..."
  AUTH_CHECK=$(docker run --rm \
    -v "$AUTH_VOLUME:/home/claude/.claude" \
    "${PROXY_RUN_ENVS[@]}" \
    "$IMAGE_NAME" \
    claude auth status 2>&1) || true

  if echo "$AUTH_CHECK" | grep -q '"loggedIn": true'; then
    EMAIL=$(echo "$AUTH_CHECK" | grep -o '"email": "[^"]*"' | head -1 | sed 's/"email": "//;s/"//')
    echo "  Authenticated as: $EMAIL"
  else
    echo ""
    echo "  Warning: Could not verify authentication."
    echo "  The proxy may fail to start. Re-run with --auth to try again."
    echo ""
    read -r -p "  Continue anyway? [y/N] " yn
    case "$yn" in
      [Yy]*) ;;
      *)     echo "  Aborted."; exit 1 ;;
    esac
  fi
fi

# ── Step 3: Start proxy ──────────────────────────────────────
echo ""
echo "==========================================="
echo "  [3/3] Starting proxy..."
echo "==========================================="

# Stop and remove existing container if present
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "  Stopping existing container..."
  docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1
fi

docker run -d \
  --name "$CONTAINER_NAME" \
  -p "$PORT:3456" \
  -v "$AUTH_VOLUME:/home/claude/.claude" \
  -v "$SESSION_VOLUME:/home/claude/.cache/meridian" \
  "${PROXY_RUN_ENVS[@]}" \
  --restart unless-stopped \
  "$IMAGE_NAME"

# Wait for health check
echo "  Waiting for proxy to be ready..."
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo ""
if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
  echo "==========================================="
  echo "  Proxy is running!"
  echo ""
  echo "  URL:    http://localhost:$PORT"
  echo "  Health: http://localhost:$PORT/health"
  echo ""
  ID_FLAG=""
  if [ -n "$INSTANCE_ID" ] && [ "$INSTANCE_ID" != "0" ]; then
    ID_FLAG=" --id $INSTANCE_ID"
  fi
  echo "  Commands:"
  echo "    docker logs -f $CONTAINER_NAME   # view logs"
  echo "    docker stop $CONTAINER_NAME      # stop"
  echo "    docker start $CONTAINER_NAME     # restart"
  echo "    $0${ID_FLAG} --upgrade           # rebuild + restart (code update)"
  echo "    $0${ID_FLAG} --auth              # re-authenticate"
  echo "==========================================="
else
  echo "  Warning: Proxy did not become healthy within 30s."
  echo "  Check logs:  docker logs $CONTAINER_NAME"
fi
