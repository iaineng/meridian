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
#   ./bin/deploy.sh --upgrade-all # rebuild image + restart ALL running instances
#   ./bin/deploy.sh --auth       # re-auth only (skip build, restart proxy)
#   ./bin/deploy.sh --no-build   # skip build, auth + run
#   ./bin/deploy.sh --proxy http://host:port          # use HTTP proxy
#   ./bin/deploy.sh --proxy socks5://host:port        # use SOCKS5 proxy
#   ./bin/deploy.sh --proxy http://host:port --no-proxy "localhost,127.0.0.1"
#   ./bin/deploy.sh --bun-runtime                        # use bun as the runtime instead of Node.js
#   ./bin/deploy.sh --obfuscation camelcase             # use CamelCase obfuscation mode
#   ./bin/deploy.sh --console                          # attach to default instance shell
#   ./bin/deploy.sh --console --id 2                   # attach to instance #2 shell
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
#   MERIDIAN_OBFUSCATION Obfuscation mode: homoglyph (default) or camelcase
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
CLEAN_MODE=false
STATUS_MODE=false
NATIVE_CLAUDE=false
CONSOLE_MODE=false
BUN_RUNTIME=false
OBFUSCATION_MODE=""
UPGRADE_ALL=false
UNIFIED_BUILD=false

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
    --upgrade-all) UPGRADE_ALL=true; shift ;;
    --_unified-build) UNIFIED_BUILD=true; shift ;;
    --clean)     CLEAN_MODE=true; shift ;;
    --status)    STATUS_MODE=true; shift ;;
    --console)   CONSOLE_MODE=true; SKIP_BUILD=true; shift ;;
    --native-claude) NATIVE_CLAUDE=true; shift ;;
    --bun-runtime)   BUN_RUNTIME=true; shift ;;
    --obfuscation)
      OBFUSCATION_MODE="$2"
      if [ "$OBFUSCATION_MODE" != "homoglyph" ] && [ "$OBFUSCATION_MODE" != "camelcase" ]; then
        echo "Error: --obfuscation must be 'homoglyph' or 'camelcase', got '$OBFUSCATION_MODE'"
        exit 1
      fi
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --id N                Instance number (0 or omitted = default instance)"
      echo "                        Each ID gets its own port, container, and volume"
      echo "  --upgrade             Rebuild image + restart container (skip auth)"
      echo "                        Use after code changes or SDK version bumps"
      echo "  --upgrade-all         Rebuild image + restart ALL running instances"
      echo "  --auth                Re-authenticate only (skip build, restart proxy)"
      echo "  --no-build            Skip Docker image build"
      echo "  --proxy URL           HTTP/SOCKS5 proxy (e.g. http://host:port, socks5://host:port)"
      echo "  --no-proxy LIST       Comma-separated proxy bypass list"
      echo "  --console             Attach to a running container's shell (use with --id)"
      echo "  --clean               Remove container and volumes for an instance"
      echo "  --status              Show status of all instances (default when no flags)"
      echo "  --obfuscation MODE    System message obfuscation: 'homoglyph' (default) or 'camelcase'"
      echo "  --bun-runtime          Use bun as the runtime instead of Node.js"
      echo "  --native-claude       Use native install (curl) instead of npm for Claude Code"
      echo "  --help                Show this help"
      echo ""
      echo "Examples:"
      echo "  $0                    # show status of all instances"
      echo "  $0 --id 1            # instance 1 → port 3457"
      echo "  $0 --upgrade          # rebuild + restart (code/SDK update)"
      echo "  $0 --upgrade-all     # rebuild + restart ALL instances"
      echo "  $0 --id 2 --upgrade  # upgrade instance 2"
      echo "  $0 --id 2 --auth     # re-auth instance 2"
      echo "  $0 --console          # attach to default instance shell"
      echo "  $0 --console --id 2  # attach to instance 2 shell"
      echo "  $0 --clean            # clean default instance"
      echo "  $0 --clean --id 2    # clean instance 2"
      echo "  $0 --native-claude   # build with native Claude Code install"
      echo ""
      echo "Environment variables:"
      echo "  MERIDIAN_PORT           Base port (default: 3456), offset by --id N"
      echo "  MERIDIAN_OBFUSCATION    System message obfuscation mode (homoglyph|camelcase)"
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

# ── Default: show status panel when no action flags given ──────
if [ "$STATUS_MODE" = false ] && [ "$CLEAN_MODE" = false ] && \
   [ "$CONSOLE_MODE" = false ] && [ "$UPGRADE_ALL" = false ] && \
   [ "$AUTH_ONLY" = false ] && [ "$SKIP_AUTH" = false ] && \
   [ "$SKIP_BUILD" = false ] && [ -z "$INSTANCE_ID" ] && \
   [ "$NATIVE_CLAUDE" = false ] && [ "$BUN_RUNTIME" = false ]; then
  STATUS_MODE=true
fi

# ── Status panel ─────────────────────────────────────────────
if [ "$STATUS_MODE" = true ]; then
  echo "==========================================="
  echo "  Meridian Instance Status"
  echo "==========================================="
  echo ""

  CONTAINERS=$(docker ps -a --filter "name=^claude-max-proxy" --format '{{.Names}}' 2>/dev/null | sort)

  if [ -z "$CONTAINERS" ]; then
    echo "  No instances found."
    echo ""
    echo "  Deploy a new instance:"
    echo "    $0 --id 0             # default instance → port 3456"
    echo "    $0 --id 1             # instance 1 → port 3457"
    exit 0
  fi

  printf "  %-10s %-25s %-10s %-7s %-8s %s\n" "Instance" "Container" "Status" "Port" "Health" "Uptime"
  printf "  %-10s %-25s %-10s %-7s %-8s %s\n" "--------" "-------------------------" "--------" "-----" "------" "------"

  for CNAME in $CONTAINERS; do
    # Instance ID
    if [ "$CNAME" = "claude-max-proxy" ]; then
      INST_ID="default"
    else
      INST_ID="${CNAME##claude-max-proxy-}"
    fi

    # Status
    CSTATUS=$(docker inspect --format '{{.State.Status}}' "$CNAME" 2>/dev/null || echo "unknown")

    # Uptime (from docker ps Status field, e.g. "Up 2 hours (healthy)")
    CUPTIME="-"
    if [ "$CSTATUS" = "running" ]; then
      CUPTIME=$(docker ps --filter "name=^${CNAME}$" --format '{{.Status}}' 2>/dev/null | sed 's/^Up //; s/ (.*//')
    fi

    # Port
    MAPPED_PORT=$(docker port "$CNAME" 3456 2>/dev/null | head -1 | sed 's/.*://')
    [ -z "$MAPPED_PORT" ] && MAPPED_PORT="-"

    # Health check
    CHEALTH="-"
    if [ "$CSTATUS" = "running" ] && [ "$MAPPED_PORT" != "-" ]; then
      if curl -sf "http://127.0.0.1:${MAPPED_PORT}/health" > /dev/null 2>&1; then
        CHEALTH="✓"
      else
        CHEALTH="✗"
      fi
    fi

    printf "  %-10s %-25s %-10s %-7s %-8s %s\n" "$INST_ID" "$CNAME" "$CSTATUS" "$MAPPED_PORT" "$CHEALTH" "$CUPTIME"
  done

  echo ""
  echo "  Commands:"
  echo "    $0 --id N             # deploy/redeploy instance N"
  echo "    $0 --id N --upgrade   # rebuild + restart instance N"
  echo "    $0 --id N --auth      # re-authenticate instance N"
  echo "    $0 --id N --console   # attach to instance N shell"
  echo "    $0 --clean --id N     # remove instance N (container + volumes)"
  echo "==========================================="
  exit 0
fi

# ── Upgrade-all mode ────────────────────────────────────────────
if [ "$UPGRADE_ALL" = true ]; then
  CONTAINERS=$(docker ps --filter "name=^claude-max-proxy" --format '{{.Names}}' 2>/dev/null | sort)

  if [ -z "$CONTAINERS" ]; then
    echo "  No running instances found. Nothing to upgrade."
    exit 0
  fi

  # Collect instance IDs
  INSTANCE_IDS=()
  for CNAME in $CONTAINERS; do
    if [ "$CNAME" = "claude-max-proxy" ]; then
      INSTANCE_IDS+=("0")
    else
      INSTANCE_IDS+=("${CNAME##claude-max-proxy-}")
    fi
  done

  echo "==========================================="
  echo "  Upgrading ALL instances: ${INSTANCE_IDS[*]}"
  echo "==========================================="
  echo ""

  # Step 1: Build image once
  echo "  [1/2] Building Docker image..."
  BUILD_ARGS=()
  if [ "$NATIVE_CLAUDE" = true ]; then
    BUILD_ARGS+=(--build-arg CLAUDE_INSTALL_METHOD=native)
  fi
  if [ "$BUN_RUNTIME" = true ]; then
    BUILD_ARGS+=(--build-arg BUN_RUNTIME=true)
  fi
  if [ -n "$NETWORK_PROXY" ]; then
    BUILD_ARGS+=(--build-arg "NATIVE_INSTALL_PROXY=$NETWORK_PROXY")
  fi
  if [ -n "$NETWORK_NO_PROXY" ]; then
    BUILD_ARGS+=(--build-arg "NATIVE_INSTALL_NO_PROXY=$NETWORK_NO_PROXY")
  fi
  docker build -f Dockerfile.deploy "${BUILD_ARGS[@]}" -t "${IMAGE_NAME:-claude-max-proxy}" .
  echo "  Build complete."
  echo ""

  # Step 2: Restart each instance
  echo "  [2/2] Restarting instances..."
  echo ""

  FAILED=()
  for IID in "${INSTANCE_IDS[@]}"; do
    echo "  ── Upgrading instance ${IID} ──"
    FORWARD_ARGS=(--id "$IID" --upgrade --no-build --_unified-build)
    if [ "$BUN_RUNTIME" = true ]; then
      FORWARD_ARGS+=(--bun-runtime)
    fi
    if [ "$NATIVE_CLAUDE" = true ]; then
      FORWARD_ARGS+=(--native-claude)
    fi
    if "$0" "${FORWARD_ARGS[@]}"; then
      echo "  ✓ Instance ${IID} upgraded."
    else
      echo "  ✗ Instance ${IID} failed."
      FAILED+=("$IID")
    fi
    echo ""
  done

  echo "==========================================="
  if [ ${#FAILED[@]} -eq 0 ]; then
    echo "  All ${#INSTANCE_IDS[@]} instances upgraded successfully."
  else
    echo "  ${#FAILED[@]} instance(s) failed: ${FAILED[*]}"
    echo "  Check logs: docker logs claude-max-proxy-<ID>"
  fi
  echo "==========================================="
  exit 0
fi

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

# ── Clean mode ───────────────────────────────────────────────
if [ "$CLEAN_MODE" = true ]; then
  echo "==========================================="
  echo "  Clean instance: ${INSTANCE_ID:-default}"
  echo "==========================================="
  echo ""
  echo "  The following resources will be removed:"

  HAS_CONTAINER=false
  HAS_AUTH_VOL=false
  HAS_SESSION_VOL=false

  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "    Container: $CONTAINER_NAME"
    HAS_CONTAINER=true
  fi
  if docker volume ls --format '{{.Name}}' | grep -q "^${AUTH_VOLUME}$"; then
    echo "    Volume:    $AUTH_VOLUME"
    HAS_AUTH_VOL=true
  fi
  if docker volume ls --format '{{.Name}}' | grep -q "^${SESSION_VOLUME}$"; then
    echo "    Volume:    $SESSION_VOLUME"
    HAS_SESSION_VOL=true
  fi

  if [ "$HAS_CONTAINER" = false ] && [ "$HAS_AUTH_VOL" = false ] && [ "$HAS_SESSION_VOL" = false ]; then
    echo "    (nothing found)"
    echo ""
    echo "  Nothing to clean."
    exit 0
  fi

  echo ""
  read -r -p "  Proceed? [y/N] " yn
  case "$yn" in
    [Yy]*)
      if [ "$HAS_CONTAINER" = true ]; then
        echo "  Removing container..."
        docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1 || true
      fi
      if [ "$HAS_AUTH_VOL" = true ]; then
        echo "  Removing auth volume..."
        docker volume rm "$AUTH_VOLUME" > /dev/null 2>&1 || true
      fi
      if [ "$HAS_SESSION_VOL" = true ]; then
        echo "  Removing session volume..."
        docker volume rm "$SESSION_VOLUME" > /dev/null 2>&1 || true
      fi
      echo ""
      echo "  Instance ${INSTANCE_ID:-default} cleaned."
      ;;
    *)
      echo "  Aborted."
      ;;
  esac
  exit 0
fi

# ── Console mode ─────────────────────────────────────────────
if [ "$CONSOLE_MODE" = true ]; then
  if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Error: Container '$CONTAINER_NAME' is not running."
    echo "  Deploy it first:  $0 --id ${INSTANCE_ID:-0}"
    exit 1
  fi
  echo "  Attaching to container '$CONTAINER_NAME'..."
  echo "  Type 'exit' to detach."
  echo ""
  docker exec -it "$CONTAINER_NAME" bash
  exit 0
fi

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

# ── Inherit native-claude setting from existing container (upgrade mode) ──
# When upgrading, if --native-claude was not explicitly passed, check the
# existing container's CLAUDE_INSTALL_METHOD env var so the build method persists.
if [ "$SKIP_AUTH" = true ] && [ "$NATIVE_CLAUDE" = false ] && [ "$UNIFIED_BUILD" = false ]; then
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    INHERITED_METHOD=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | grep -m1 "^CLAUDE_INSTALL_METHOD=" | cut -d= -f2-)
    if [ "$INHERITED_METHOD" = "native" ]; then
      NATIVE_CLAUDE=true
      echo "  Inherited native Claude install from existing container."
    fi
  fi
fi

# ── Inherit bun-runtime setting from existing container (upgrade mode) ──
if [ "$SKIP_AUTH" = true ] && [ "$BUN_RUNTIME" = false ] && [ "$UNIFIED_BUILD" = false ]; then
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    INHERITED_BUN=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | grep -m1 "^BUN_RUNTIME=" | cut -d= -f2-)
    if [ "$INHERITED_BUN" = "true" ]; then
      BUN_RUNTIME=true
      echo "  Inherited bun runtime from existing container."
    fi
  fi
fi

# ── Inherit obfuscation setting from existing container (upgrade mode) ──
if [ "$SKIP_AUTH" = true ] && [ -z "$OBFUSCATION_MODE" ]; then
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    INHERITED_OBFUSCATION=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | grep -m1 "^MERIDIAN_OBFUSCATION=" | cut -d= -f2-)
    if [ -n "$INHERITED_OBFUSCATION" ]; then
      OBFUSCATION_MODE="$INHERITED_OBFUSCATION"
      echo "  Inherited obfuscation mode from existing container: $OBFUSCATION_MODE"
    fi
  fi
fi

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
  BUILD_ARGS=()
  if [ "$NATIVE_CLAUDE" = true ]; then
    BUILD_ARGS+=(--build-arg CLAUDE_INSTALL_METHOD=native)
  fi
  if [ "$BUN_RUNTIME" = true ]; then
    BUILD_ARGS+=(--build-arg BUN_RUNTIME=true)
  fi
  if [ -n "$NETWORK_PROXY" ]; then
    BUILD_ARGS+=(--build-arg "NATIVE_INSTALL_PROXY=$NETWORK_PROXY")
  fi
  if [ -n "$NETWORK_NO_PROXY" ]; then
    BUILD_ARGS+=(--build-arg "NATIVE_INSTALL_NO_PROXY=$NETWORK_NO_PROXY")
  fi
  docker build -f Dockerfile.deploy "${BUILD_ARGS[@]}" -t "$IMAGE_NAME" .
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

OBFUSCATION_ENVS=()
if [ -n "$OBFUSCATION_MODE" ]; then
  OBFUSCATION_ENVS+=(-e "MERIDIAN_OBFUSCATION=$OBFUSCATION_MODE")
fi

BUN_RUNTIME_ENVS=()
if [ "$BUN_RUNTIME" = true ]; then
  BUN_RUNTIME_ENVS+=(-e "BUN_RUNTIME=true")
fi

docker run -d \
  --name "$CONTAINER_NAME" \
  -p "$PORT:3456" \
  -v "$AUTH_VOLUME:/home/claude/.claude" \
  -v "$SESSION_VOLUME:/home/claude/.cache/meridian" \
  "${PROXY_RUN_ENVS[@]}" \
  "${OBFUSCATION_ENVS[@]}" \
  "${BUN_RUNTIME_ENVS[@]}" \
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
  echo "    $0${ID_FLAG} --console           # attach to container shell"
  echo "    $0${ID_FLAG} --upgrade           # rebuild + restart (code update)"
  echo "    $0${ID_FLAG} --auth              # re-authenticate"
  echo "==========================================="
else
  echo "  Warning: Proxy did not become healthy within 30s."
  echo "  Check logs:  docker logs $CONTAINER_NAME"
fi
