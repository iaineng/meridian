#!/bin/bash
# VM-style Docker deployment script.
#
# Treats containers as long-lived virtual machines — no image building.
# Uses a complete Ubuntu system image directly, installs everything
# inside the running container via `docker exec`.
#
# Usage:
#   ./bin/deploy-vm.sh ACTION [ACTION...] [--id N[,N...]]
#     Multiple actions run in order. With multiple IDs, the full action
#     queue runs sequentially per ID:
#       ./bin/deploy-vm.sh update migrate-tmpfs --id 0,1
#         → id 0: update, migrate-tmpfs; then id 1: update, migrate-tmpfs
#
#   ./bin/deploy-vm.sh                          # show status (default)
#   ./bin/deploy-vm.sh build                    # build base image (Node/Bun pre-installed)
#   ./bin/deploy-vm.sh deploy                   # full deploy: build+create+setup+auth+install+start
#   ./bin/deploy-vm.sh create                   # create VM container
#   ./bin/deploy-vm.sh setup                    # install Node/Bun/Claude in container
#   ./bin/deploy-vm.sh auth                     # authenticate with Claude
#   ./bin/deploy-vm.sh install                  # copy project + build
#   ./bin/deploy-vm.sh update                   # re-sync project + rebuild (preserves auth)
#   ./bin/deploy-vm.sh update-claude            # update claude CLI inside the container
#   ./bin/deploy-vm.sh start                    # start proxy
#   ./bin/deploy-vm.sh stop                     # stop proxy
#   ./bin/deploy-vm.sh restart                  # restart proxy
#   ./bin/deploy-vm.sh status                   # show status table
#   ./bin/deploy-vm.sh shell                    # interactive shell
#   ./bin/deploy-vm.sh migrate-tmpfs            # recreate with --tmpfs JSONL (preserves /app + auth via docker cp)
#   ./bin/deploy-vm.sh delete                   # remove container (with confirmation)
#   ./bin/deploy-vm.sh list                     # list all meridian-vm containers
#
# Options:
#   --id N[,N...]   Instance number(s). Comma-separated list runs each action
#                   in order per ID. (0 or omitted = default instance.)
#                   Pass `all` to expand to every existing meridian-vm*
#                   container (sorted by id; includes stopped ones).
#                   `all` is not valid with `create` — there is no new
#                   instance to discover for a constructive action.
#                   Each ID gets its own port and container:
#                     --id 0 (default) → port 3456, container meridian-vm
#                     --id 1           → port 3457, container meridian-vm-1
#                     --id 2           → port 3458, container meridian-vm-2
#                     --id all         → every discovered instance
#   --name NAME     Container name (overrides --id naming; single ID only)
#   --port PORT     Host port mapping (overrides --id port; single ID only)
#   --image IMAGE   Base image (default: meridian-vm-base, built from ubuntu:22.04)
#   --proxy URL     HTTP/SOCKS5 proxy (e.g. http://host:port, socks5://host:port)
#   --no-proxy LIST Comma-separated proxy bypass list
#   --tmpfs-jsonl   Mount the JSONL session directory on a tmpfs (RAM disk)
#                   inside the container. Only takes effect at `create` /
#                   `deploy` time — existing containers must be recreated.
#                   Pair with MERIDIAN_EPHEMERAL_JSONL=1 for zero-disk
#                   transcript churn.
#   --tmpfs-jsonl-size SIZE
#                   tmpfs size for --tmpfs-jsonl (default: 1g). Accepts
#                   any `--tmpfs` size suffix (k, m, g).
#   --force         Skip confirmations (for delete)
#
# Environment variables:
#   HTTP_PROXY / HTTPS_PROXY / ALL_PROXY  Network proxy (overridden by --proxy)
#   NO_PROXY                              Proxy bypass list (overridden by --no-proxy)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
cd "$PROJECT_DIR"

# Defaults
COMMANDS=()
INSTANCE_IDS=()
CONTAINER_NAME=""
HOST_PORT=""
# Track whether --name / --port were explicitly given (so the per-ID loop
# does not clobber a user override, and so we can reject the combination
# with multiple IDs).
NAME_OVERRIDE=""
PORT_OVERRIDE=""
ID_ALL=false
BASE_IMAGE="meridian-vm-base"
VM_IMAGE_NAME="meridian-vm-base"
FORCE=false
NETWORK_PROXY=""
NETWORK_NO_PROXY=""
TMPFS_JSONL=false
TMPFS_JSONL_SIZE="1g"
# JSONL session transcripts live under $HOME/.claude/projects for the in-
# container claude user. When --tmpfs-jsonl is set, this path is mounted on
# a tmpfs so transcripts never touch the container's writable layer.
TMPFS_JSONL_PATH="/home/claude/.claude/projects"

# ─── Argument parsing ────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    build|deploy|create|setup|auth|install|update|update-claude|start|stop|restart|status|shell|root-shell|delete|list|migrate-tmpfs)
      COMMANDS+=("$1"); shift ;;
    --id)
      if [ -z "${2:-}" ]; then
        echo "Error: --id requires a value"
        exit 1
      fi
      IFS=',' read -ra _ids <<< "$2"
      for _id in "${_ids[@]}"; do
        if [ "$_id" = "all" ]; then
          ID_ALL=true
        elif [[ "$_id" =~ ^[0-9]+$ ]]; then
          INSTANCE_IDS+=("$_id")
        else
          echo "Error: --id requires non-negative integers or 'all' (comma-separated), got '$_id'"
          exit 1
        fi
      done
      shift 2 ;;
    --name)
      if [ -z "${2:-}" ]; then
        echo "Error: --name requires a value"
        exit 1
      fi
      NAME_OVERRIDE="$2"; shift 2 ;;
    --port)
      if [ -z "${2:-}" ]; then
        echo "Error: --port requires a value"
        exit 1
      fi
      PORT_OVERRIDE="$2"; shift 2 ;;
    --image)
      BASE_IMAGE="$2"; shift 2 ;;
    --proxy)
      NETWORK_PROXY="$2"; shift 2 ;;
    --no-proxy)
      NETWORK_NO_PROXY="$2"; shift 2 ;;
    --tmpfs-jsonl)
      TMPFS_JSONL=true; shift ;;
    --tmpfs-jsonl-size)
      TMPFS_JSONL_SIZE="$2"; shift 2 ;;
    --force)
      FORCE=true; shift ;;
    --help|-h)
      # Print the leading comment block (everything from line 2 up to the
      # first non-comment, non-blank line). Self-updates as the header grows.
      awk 'NR==1 { next } /^#/ || /^$/ { print; next } { exit }' "$0"
      exit 0 ;;
    *)
      echo "Error: Unknown option '$1'"
      echo "Run '$0 --help' for usage."
      exit 1 ;;
  esac
done

# Defaults after parsing
[ ${#COMMANDS[@]} -eq 0 ] && COMMANDS=("status")

# Expand `--id all`: discover every existing meridian-vm* container and
# extract its instance id. `meridian-vm` maps to id 0; `meridian-vm-N`
# maps to id N. Anchored regex filter avoids accidental substring matches
# (e.g. a container named `other-meridian-vm-helper`).
if [ "$ID_ALL" = true ]; then
  # Constructive actions need explicit IDs — `all` discovers existing
  # containers, which by definition excludes the one being created.
  # `deploy` is rejected because it internally runs `create`.
  for _cmd in "${COMMANDS[@]}"; do
    case "$_cmd" in
      create|deploy)
        echo "Error: --id all cannot be combined with '$_cmd' (no new instance to discover)"
        exit 1 ;;
    esac
  done

  # Surface real docker errors (e.g. daemon not running) instead of
  # misreporting them as "no containers found".
  _discovered=$(docker ps -a --filter 'name=^meridian-vm(-[0-9]+)?$' --format '{{.Names}}' | sort -V)
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    echo "Error: --id all: 'docker ps' failed (is the docker daemon running?)"
    exit 1
  fi
  if [ -z "$_discovered" ]; then
    echo "Error: --id all: no meridian-vm* containers found."
    exit 1
  fi
  while IFS= read -r _name; do
    if [ "$_name" = "meridian-vm" ]; then
      INSTANCE_IDS+=("0")
    elif [[ "$_name" =~ ^meridian-vm-([0-9]+)$ ]]; then
      INSTANCE_IDS+=("${BASH_REMATCH[1]}")
    fi
  done <<< "$_discovered"
fi

# De-duplicate IDs (covers `--id 1,1,2` and `--id 1,all` alike).
# `unset` brackets `declare -A` to stay correct if this script is ever
# sourced into an existing shell where `_seen` might already hold state.
if [ ${#INSTANCE_IDS[@]} -gt 1 ]; then
  _unique_ids=()
  unset _seen
  declare -A _seen
  for _id in "${INSTANCE_IDS[@]}"; do
    if [ -z "${_seen[$_id]:-}" ]; then
      _unique_ids+=("$_id")
      _seen[$_id]=1
    fi
  done
  INSTANCE_IDS=("${_unique_ids[@]}")
  unset _seen
fi

# Default to the primary instance when no --id was provided.
[ ${#INSTANCE_IDS[@]} -eq 0 ] && INSTANCE_IDS=("0")

# Mutex: --name / --port cannot fan out across multiple IDs.
if [ ${#INSTANCE_IDS[@]} -gt 1 ] && { [ -n "$NAME_OVERRIDE" ] || [ -n "$PORT_OVERRIDE" ]; }; then
  echo "Error: --name/--port cannot be combined with multiple --id values"
  exit 1
fi

# ─── Resolve --id into container name and port ───────────────────────

BASE_PORT=3456

# Set CONTAINER_NAME and HOST_PORT for the given instance id, unless the
# user supplied an explicit --name / --port override.
resolve_instance_vars() {
  local id="$1"
  if [ -n "$NAME_OVERRIDE" ]; then
    CONTAINER_NAME="$NAME_OVERRIDE"
  elif [ "$id" = "0" ]; then
    CONTAINER_NAME="meridian-vm"
  else
    CONTAINER_NAME="meridian-vm-${id}"
  fi
  if [ -n "$PORT_OVERRIDE" ]; then
    HOST_PORT="$PORT_OVERRIDE"
  elif [ "$id" = "0" ]; then
    HOST_PORT="$BASE_PORT"
  else
    HOST_PORT=$((BASE_PORT + id))
  fi
}

# ─── Preflight ────────────────────────────────────────────────────────

if ! command -v docker > /dev/null 2>&1; then
  echo "Error: docker is not installed or not on PATH."
  exit 1
fi

# Resolve proxy from environment if not set via flags
NETWORK_PROXY="${NETWORK_PROXY:-${ALL_PROXY:-${HTTPS_PROXY:-${HTTP_PROXY:-}}}}"
NETWORK_NO_PROXY="${NETWORK_NO_PROXY:-${NO_PROXY:-}}"

if [ -n "$NETWORK_PROXY" ]; then
  echo "  Network proxy: $NETWORK_PROXY"
fi
if [ -n "$NETWORK_NO_PROXY" ]; then
  echo "  No-proxy list: $NETWORK_NO_PROXY"
fi
if [ "$TMPFS_JSONL" = true ]; then
  echo "  tmpfs JSONL:   $TMPFS_JSONL_PATH (size=$TMPFS_JSONL_SIZE)"
fi

# Emit the `docker run --tmpfs ...` flag when --tmpfs-jsonl is set. Nothing
# otherwise. mode=0700 + chowning to claude inside the container keeps the
# mount private to the claude user.
tmpfs_mount_args() {
  if [ "$TMPFS_JSONL" = true ]; then
    echo "--tmpfs ${TMPFS_JSONL_PATH}:rw,size=${TMPFS_JSONL_SIZE},mode=0700"
  fi
}

# Build proxy export string for injection into docker exec commands
proxy_env() {
  local env=""
  if [ -n "$NETWORK_PROXY" ]; then
    env+="export HTTP_PROXY='$NETWORK_PROXY'; "
    env+="export HTTPS_PROXY='$NETWORK_PROXY'; "
    env+="export ALL_PROXY='$NETWORK_PROXY'; "
    env+="export http_proxy='$NETWORK_PROXY'; "
    env+="export https_proxy='$NETWORK_PROXY'; "
    env+="export all_proxy='$NETWORK_PROXY'; "
  fi
  if [ -n "$NETWORK_NO_PROXY" ]; then
    env+="export NO_PROXY='$NETWORK_NO_PROXY'; "
    env+="export no_proxy='$NETWORK_NO_PROXY'; "
  fi
  echo "$env"
}

# ─── Helper functions ─────────────────────────────────────────────────

container_exists() {
  docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"
}

container_running() {
  docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"
}

require_container() {
  if ! container_exists; then
    echo "Error: Container '$CONTAINER_NAME' does not exist."
    echo "  Run: $0 create --name $CONTAINER_NAME"
    exit 1
  fi
  if ! container_running; then
    echo "Error: Container '$CONTAINER_NAME' is not running."
    echo "  Start it: docker start $CONTAINER_NAME"
    exit 1
  fi
}

exec_as_root() {
  docker exec "$CONTAINER_NAME" bash -c "$*"
}

exec_as_claude() {
  docker exec --user claude "$CONTAINER_NAME" bash -c "$*"
}

# Proxy-aware variants — only use where proxy is needed
exec_as_root_proxy() {
  docker exec "$CONTAINER_NAME" bash -c "$(proxy_env)$*"
}

exec_as_claude_proxy() {
  docker exec --user claude "$CONTAINER_NAME" bash -c "$(proxy_env)$*"
}

get_proxy_pid() {
  docker exec "$CONTAINER_NAME" bash -c \
    'p=$(cat /tmp/meridian-supervisor.pid 2>/dev/null); [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p" || echo ""' 2>/dev/null || echo ""
}

proxy_running() {
  local pid
  pid=$(get_proxy_pid)
  [ -n "$pid" ]
}

health_check() {
  curl -sf "http://127.0.0.1:${HOST_PORT}/health" > /dev/null 2>&1
}

get_mapped_port() {
  local cname="$1"
  docker port "$cname" 3456 2>/dev/null | head -1 | sed 's/.*://'
}

print_banner() {
  echo "==========================================="
  echo "  $1"
  echo "==========================================="
}

# Internal: stop proxy without banner output
stop_quiet() {
  local pid
  pid=$(get_proxy_pid)
  if [ -n "$pid" ]; then
    # Kill child processes (the actual proxy) first, then the supervisor
    docker exec "$CONTAINER_NAME" bash -c "
      pkill -P $pid 2>/dev/null
      kill $pid 2>/dev/null
      rm -f /tmp/meridian-supervisor.pid
      # Wait briefly for processes to exit
      sleep 1
      # Force kill any survivors
      pkill -9 -P $pid 2>/dev/null
      kill -9 $pid 2>/dev/null
    " 2>/dev/null || true
    sleep 2
  fi
}

# Internal: start proxy without banner output
start_quiet() {
  docker exec -d --user claude "$CONTAINER_NAME" bash -c "
    $(proxy_env)
    export MERIDIAN_PASSTHROUGH=1
    export MERIDIAN_HOST=0.0.0.0
    export MERIDIAN_PORT=3456
    export MERIDIAN_MAX_CONCURRENT=10
    export MERIDIAN_NO_FILE_CHANGES=1
    export MERIDIAN_OBFUSCATION=cr
    export MERIDIAN_BETA_POLICY=strip-all
    export MERIDIAN_EPHEMERAL_JSONL=1
    export PATH=\"/home/claude/.claude/bin:/home/claude/.local/bin:/usr/local/bin:\$PATH\"
    cd /app
    nohup ./bin/claude-proxy-supervisor.sh > /tmp/meridian.log 2>&1 &
    echo \$! > /tmp/meridian-supervisor.pid
  "
}

# ─── Commands ─────────────────────────────────────────────────────────

cmd_build() {
  print_banner "Building base image: $VM_IMAGE_NAME"
  echo ""

  docker build -t "$VM_IMAGE_NAME" -f "$PROJECT_DIR/Dockerfile.vm" "$PROJECT_DIR"

  echo ""
  echo "  Base image built: $VM_IMAGE_NAME"
  echo "  Contains: system packages, Node.js 22, Bun"
  echo ""
  echo "  Next step: $0 create"
}

cmd_deploy() {
  print_banner "Full deployment: $CONTAINER_NAME"
  echo "  Image:  $BASE_IMAGE"
  echo "  Port:   $HOST_PORT -> 3456"
  echo ""

  # Step 0: Build base image if not exists
  if ! docker image inspect "$VM_IMAGE_NAME" > /dev/null 2>&1; then
    echo "── [0/5] Building base image ──────────────────────────"
    cmd_build
    echo ""
  fi

  # Step 1: Create
  if container_exists; then
    echo "  Container '$CONTAINER_NAME' already exists, skipping create."
    if ! container_running; then
      echo "  Starting existing container..."
      docker start "$CONTAINER_NAME" > /dev/null
    fi
  else
    echo "── [1/5] Creating container ──────────────────────────"
    docker run -d \
      --name "$CONTAINER_NAME" \
      --runtime=runsc \
      -p "${HOST_PORT}:3456" \
      $(tmpfs_mount_args) \
      "$BASE_IMAGE" \
      sleep infinity > /dev/null
    [ "$TMPFS_JSONL" = true ] && docker exec "$CONTAINER_NAME" \
      chown claude:claude "$TMPFS_JSONL_PATH" > /dev/null 2>&1
    echo "  Container created."
  fi
  echo ""

  # Step 2: Setup (claude user + Claude CLI)
  echo "── [2/5] Setting up environment ─────────────────────"
  cmd_setup
  echo ""

  # Step 3: Auth
  echo "── [3/5] Authenticating Claude ──────────────────────"
  cmd_auth
  echo ""

  # Step 4: Install
  echo "── [4/5] Installing project ─────────────────────────"
  cmd_install
  echo ""

  # Step 5: Start
  echo "── [5/5] Starting proxy ─────────────────────────────"
  cmd_start
}

cmd_create() {
  if container_exists; then
    echo "Error: Container '$CONTAINER_NAME' already exists."
    echo "  Use '$0 setup --name $CONTAINER_NAME' to install dependencies."
    echo "  Use '$0 delete --name $CONTAINER_NAME' to remove it first."
    exit 1
  fi

  print_banner "Creating container: $CONTAINER_NAME"
  echo "  Image:  $BASE_IMAGE"
  echo "  Port:   $HOST_PORT -> 3456"
  echo ""

  docker run -d \
    --name "$CONTAINER_NAME" \
    --runtime=runsc \
    -p "${HOST_PORT}:3456" \
    $(tmpfs_mount_args) \
    "$BASE_IMAGE" \
    sleep infinity

  [ "$TMPFS_JSONL" = true ] && docker exec "$CONTAINER_NAME" \
    chown claude:claude "$TMPFS_JSONL_PATH" > /dev/null 2>&1

  echo ""
  echo "  Container created."
  echo ""
  echo "  Next step: $0 setup --name $CONTAINER_NAME"
}

cmd_setup() {
  require_container

  print_banner "Setting up container: $CONTAINER_NAME"
  echo ""

  # Install Claude Code CLI (native install as claude user)
  echo "  Installing Claude Code CLI (native)..."
  # Download install script without proxy
  exec_as_claude_proxy "
    curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh
    if [ \$? -ne 0 ]; then
      echo '  Error: Failed to download Claude install script.'
      exit 1
    fi
  "
  if [ $? -ne 0 ]; then
    echo "  Error: Failed to download Claude install script."
    exit 1
  fi
  # Run install script with proxy (downloads binary via proxy)
  exec_as_claude_proxy "
    bash /tmp/claude-install.sh 2>&1 | tail -5
    rm -f /tmp/claude-install.sh
    # Verify claude binary exists
    if [ ! -f /home/claude/.claude/bin/claude ] && [ ! -f /home/claude/.local/bin/claude ]; then
      echo '  Error: Claude Code CLI binary not found after install.'
      exit 1
    fi
    echo \"  claude \$(/home/claude/.claude/bin/claude --version 2>/dev/null || /home/claude/.local/bin/claude --version 2>/dev/null || echo 'unknown')\"
  "
  if [ $? -ne 0 ]; then
    echo "  Error: Claude Code CLI installation failed."
    echo "  Check your network/proxy settings and try again: $0 setup --name $CONTAINER_NAME"
    exit 1
  fi
  # Add claude bin to system-wide PATH
  exec_as_root "
    echo 'export PATH=\"/home/claude/.claude/bin:/home/claude/.local/bin:\$PATH\"' > /etc/profile.d/claude.sh
    chmod +x /etc/profile.d/claude.sh
  "
  echo "  Done."

  echo ""
  echo "  Setup complete."
  echo ""
  echo "  Next step: $0 auth --name $CONTAINER_NAME"
}

cmd_auth() {
  require_container

  print_banner "Authenticating Claude in: $CONTAINER_NAME"
  echo ""
  echo "  Running 'claude' inside the container..."
  echo ""

  docker exec -it --user claude "$CONTAINER_NAME" bash -c "
    $(proxy_env)
    export PATH=\"/home/claude/.claude/bin:/home/claude/.local/bin:/usr/local/bin:\$PATH\"
    claude
  "

  # Verify
  echo ""
  echo "  Verifying authentication..."
  local auth_check
  auth_check=$(docker exec --user claude "$CONTAINER_NAME" bash -c "
    $(proxy_env)
    export PATH=\"/home/claude/.claude/bin:/home/claude/.local/bin:/usr/local/bin:\$PATH\"
    claude auth status 2>&1
  ") || true

  if echo "$auth_check" | grep -q '"loggedIn": true'; then
    local email
    email=$(echo "$auth_check" | grep -o '"email": "[^"]*"' | head -1 | sed 's/"email": "//;s/"//')
    echo "  Authenticated as: $email"

    # Patch hasCompletedOnboarding to suppress interactive prompts
    docker exec --user claude "$CONTAINER_NAME" bash -c '
      CLAUDE_JSON="/home/claude/.claude.json"
      if [ -f "$CLAUDE_JSON" ]; then
        if command -v node > /dev/null 2>&1; then
          node -e "
            const fs = require(\"fs\");
            const f = \"$CLAUDE_JSON\";
            try {
              const d = JSON.parse(fs.readFileSync(f, \"utf8\"));
              d.hasCompletedOnboarding = true;
              fs.writeFileSync(f, JSON.stringify(d, null, 2));
            } catch(e) {}
          "
        fi
      fi
    ' 2>/dev/null || true

    echo ""
    echo "  Next step: $0 install --name $CONTAINER_NAME"
  else
    echo "  Warning: Could not verify authentication."
    echo "  Re-run '$0 auth --name $CONTAINER_NAME' to try again."
    exit 1
  fi
}

cmd_install() {
  require_container

  print_banner "Installing project in: $CONTAINER_NAME"
  echo ""

  # Step 1: Copy project files via tar pipe
  echo "  [1/3] Copying project files..."
  tar -C "$PROJECT_DIR" \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.env*' \
    -czf - . \
    | docker exec -i "$CONTAINER_NAME" bash -c \
        'rm -rf /app && mkdir -p /app && tar -xzf - -C /app && chown -R claude:claude /app'
  echo "  Done."

  # Step 2: Install dependencies
  echo "  [2/3] Installing dependencies (bun install)..."
  exec_as_claude "cd /app && bun install 2>&1 | tail -10"
  echo "  Done."

  # Step 3: Build
  echo "  [3/3] Building project..."
  exec_as_claude "
    cd /app
    rm -rf dist
    bun build bin/cli.ts src/proxy/server.ts \
      --outdir dist --target node --splitting \
      --external @anthropic-ai/claude-agent-sdk \
      --external @node-rs/xxhash \
      --entry-naming '[name].js' 2>&1 | tail -5
  "
  echo "  Done."

  # Fix supervisor script line endings (Windows CRLF -> LF)
  exec_as_root "
    sed -i 's/\r$//' /app/bin/claude-proxy-supervisor.sh 2>/dev/null || true
    chmod +x /app/bin/claude-proxy-supervisor.sh
  "

  echo ""
  echo "  Install complete."
  echo ""
  echo "  Next step: $0 start --name $CONTAINER_NAME"
}

cmd_update() {
  require_container

  print_banner "Updating project in: $CONTAINER_NAME"
  echo "  (Auth and sessions are preserved)"
  echo ""

  local proxy_was_running=false
  proxy_running && proxy_was_running=true

  # Steps 1–3 run while the proxy keeps serving. Node holds loaded modules
  # in memory, so tar-overwriting /app and mutating node_modules does not
  # affect the running process. `--unlink-first` gives us rename semantics
  # so any file an active shell (e.g. the supervisor) reads from keeps its
  # old inode.

  # Step 1: Sync project files (live)
  echo "  [1/4] Syncing project files..."
  tar -C "$PROJECT_DIR" \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='dist.new' \
    --exclude='dist.old' \
    --exclude='.env*' \
    -czf - . \
    | docker exec -i "$CONTAINER_NAME" bash -c \
        'mkdir -p /app && tar --unlink-first -xzf - -C /app && chown -R claude:claude /app'
  echo "  Done."

  # Step 2: Reinstall deps (live)
  echo "  [2/4] Installing dependencies..."
  exec_as_claude "cd /app && bun install 2>&1 | tail -5"
  echo "  Done."

  # Step 3: Build to dist.new (live — running proxy still reads from dist/).
  # If the proxy happens to crash during this window, the supervisor
  # restarts it from the unchanged dist/ and stays healthy.
  #
  # Prep dist.new as root to wipe any stale copy (gVisor sometimes leaves
  # root-owned leftovers that survive `chown -R /app`).
  echo "  [3/4] Building to dist.new..."
  exec_as_root "rm -rf /app/dist.new && mkdir -p /app/dist.new && chown claude:claude /app/dist.new"
  exec_as_claude "
    cd /app
    bun build bin/cli.ts src/proxy/server.ts \
      --outdir dist.new --target node --splitting \
      --external @anthropic-ai/claude-agent-sdk \
      --external @node-rs/xxhash \
      --entry-naming '[name].js' 2>&1 | tail -5
  "
  echo "  Done."

  # Fix supervisor script line endings (safe — sed -i uses rename)
  exec_as_root "
    sed -i 's/\r$//' /app/bin/claude-proxy-supervisor.sh 2>/dev/null || true
    chmod +x /app/bin/claude-proxy-supervisor.sh
  "

  # Step 4: Short downtime window — stop, swap dist, start.
  # Done as root so we are immune to any lingering ownership skew.
  echo "  [4/4] Swapping dist and restarting..."
  if [ "$proxy_was_running" = true ]; then
    stop_quiet
  fi
  exec_as_root "
    cd /app
    rm -rf dist.old
    [ -d dist ] && mv dist dist.old
    mv dist.new dist
    chown -R claude:claude dist
    rm -rf dist.old
  "
  if [ "$proxy_was_running" = true ]; then
    start_quiet
    sleep 2
    if health_check; then
      echo "  Proxy restarted and healthy."
    else
      echo "  Warning: Proxy may not be ready yet. Check with '$0 status'."
    fi
  fi

  echo ""
  echo "  Update complete."
}

# Recreate the container with --tmpfs mounted at the JSONL session directory,
# preserving /app and /home/claude by tar-streaming them out and back in.
#
# NOTE: `docker commit` is unreliable under the gVisor (runsc) runtime —
# writes inside the sandbox aren't always visible to the daemon's overlay,
# so the committed image can end up missing /app, auth, etc. Streaming via
# `docker exec tar` goes through the live container's filesystem (through
# the gofer), which sees the real state. /home/claude/.claude/projects is
# excluded on the way out because it's the tmpfs target and would otherwise
# overflow the (default 128m) mount on the way back.
cmd_update_claude() {
  require_container

  print_banner "Updating claude CLI in: $CONTAINER_NAME"
  echo "  (Proxy keeps running — new binary is picked up on next claude spawn.)"
  echo ""

  echo "  Running: ~/.local/bin/claude update"
  echo "  ----------------------------------------"
  local update_rc=0
  docker exec --user claude "$CONTAINER_NAME" bash -c "
    $(proxy_env)
    export PATH=\"/home/claude/.claude/bin:/home/claude/.local/bin:/usr/local/bin:\$PATH\"
    if [ -x /home/claude/.local/bin/claude ]; then
      /home/claude/.local/bin/claude update
    elif [ -x /home/claude/.claude/bin/claude ]; then
      /home/claude/.claude/bin/claude update
    else
      echo 'Error: claude binary not found in /home/claude/.local/bin or /home/claude/.claude/bin'
      exit 1
    fi
  " || update_rc=$?
  echo "  ----------------------------------------"
  echo ""

  echo "  New version:"
  docker exec --user claude "$CONTAINER_NAME" bash -c "
    export PATH=\"/home/claude/.claude/bin:/home/claude/.local/bin:/usr/local/bin:\$PATH\"
    claude --version 2>/dev/null || echo '  (unable to read version)'
  " | sed 's/^/    /'
  echo ""

  if [ $update_rc -ne 0 ]; then
    echo "  Warning: claude update exited with status $update_rc."
    exit $update_rc
  fi

  echo "  claude CLI update complete."
}

cmd_migrate_tmpfs() {
  require_container

  # Force the flag on — this command is exclusively for introducing tmpfs.
  # --tmpfs-jsonl-size is still honored if the user passed it.
  TMPFS_JSONL=true

  local stage_dir="/tmp/${CONTAINER_NAME}-migrate-$(date +%Y%m%d-%H%M%S)"
  local actual_port
  actual_port=$(get_mapped_port "$CONTAINER_NAME")
  [ -z "$actual_port" ] && actual_port="$HOST_PORT"
  local actual_runtime
  actual_runtime=$(docker inspect --format '{{.HostConfig.Runtime}}' "$CONTAINER_NAME" 2>/dev/null)
  [ -z "$actual_runtime" ] && actual_runtime="runsc"
  local actual_image
  actual_image=$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null)
  [ -z "$actual_image" ] && actual_image="$BASE_IMAGE"

  print_banner "Migrating $CONTAINER_NAME → tmpfs JSONL"
  echo "  Stage dir:      $stage_dir"
  echo "  Source image:   $actual_image"
  echo "  Mount:          $TMPFS_JSONL_PATH (size=$TMPFS_JSONL_SIZE)"
  echo "  Port:           $actual_port -> 3456"
  echo "  Runtime:        $actual_runtime"
  echo ""

  # Step 1: Stop proxy (graceful). Container stays running so we can tar/cp
  # against its live sandbox filesystem.
  echo "── [1/6] Stopping proxy ─────────────────────────────"
  stop_quiet
  echo "  Done."

  # Step 2: Stream /app and /home/claude out to host staging dir.
  # /home/claude is pulled via `tar --exclude` so we skip the old projects
  # dir — it would otherwise be copied back in and overflow the 128m tmpfs.
  echo "── [2/6] Copying state to host ──────────────────────"
  mkdir -p "$stage_dir/app" "$stage_dir/claude"
  if ! docker exec "$CONTAINER_NAME" tar -C /app -cf - . 2>/dev/null \
       | tar -C "$stage_dir/app" -xf - 2>/dev/null; then
    echo "  Error: /app copy failed. Aborting without touching container."
    rm -rf "$stage_dir"
    start_quiet
    exit 1
  fi
  echo "    ✓ /app"
  if ! docker exec "$CONTAINER_NAME" tar -C /home/claude \
         --exclude='./.claude/projects' \
         -cf - . 2>/dev/null \
       | tar -C "$stage_dir/claude" -xf - 2>/dev/null; then
    echo "  Error: /home/claude copy failed. Aborting."
    rm -rf "$stage_dir"
    start_quiet
    exit 1
  fi
  echo "    ✓ /home/claude (minus .claude/projects)"
  # Sanity check: /app must contain the supervisor script
  if [ ! -f "$stage_dir/app/bin/claude-proxy-supervisor.sh" ]; then
    echo "  Error: /app/bin/claude-proxy-supervisor.sh missing in staged copy."
    echo "  Aborting — stage kept at $stage_dir for inspection."
    start_quiet
    exit 1
  fi
  echo "  Done."

  # Step 3: Remove old container
  echo "── [3/6] Removing old container ─────────────────────"
  if ! docker rm -f "$CONTAINER_NAME" > /dev/null; then
    echo "  Error: failed to remove old container. State staged at $stage_dir"
    exit 1
  fi
  echo "  Done."

  # Step 4: Recreate container from the original base image with tmpfs
  echo "── [4/6] Recreating with tmpfs ──────────────────────"
  if ! docker run -d \
    --name "$CONTAINER_NAME" \
    --runtime="$actual_runtime" \
    -p "${actual_port}:3456" \
    $(tmpfs_mount_args) \
    "$actual_image" \
    sleep infinity > /dev/null; then
    echo "  Error: docker run failed. State staged at $stage_dir"
    exit 1
  fi
  docker exec "$CONTAINER_NAME" chown claude:claude "$TMPFS_JSONL_PATH" > /dev/null 2>&1
  echo "  Done."

  # Step 5: Stream staged state back. /app gets replaced outright; for
  # /home/claude we tar-extract on top (merge), which skates past the
  # tmpfs submount at .claude/projects — nothing in the stage touches it.
  echo "── [5/6] Restoring state into new container ─────────"
  docker exec "$CONTAINER_NAME" rm -rf /app > /dev/null 2>&1
  docker exec "$CONTAINER_NAME" mkdir -p /app > /dev/null 2>&1
  if tar -C "$stage_dir/app" -cf - . 2>/dev/null \
     | docker exec -i "$CONTAINER_NAME" tar -C /app -xf - 2>/dev/null; then
    echo "    ✓ /app"
  else
    echo "    ✗ /app (restore failed)"
  fi
  if tar -C "$stage_dir/claude" -cf - . 2>/dev/null \
     | docker exec -i "$CONTAINER_NAME" tar -C /home/claude -xf - 2>/dev/null; then
    echo "    ✓ /home/claude"
  else
    echo "    ✗ /home/claude (restore failed)"
  fi
  docker exec "$CONTAINER_NAME" chown -R claude:claude /home/claude /app > /dev/null 2>&1
  docker exec "$CONTAINER_NAME" chmod +x /app/bin/claude-proxy-supervisor.sh > /dev/null 2>&1
  echo "  Done."

  # Step 6: Start proxy and verify
  echo "── [6/6] Starting proxy ─────────────────────────────"
  start_quiet
  local ready=false
  for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${actual_port}/health" > /dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if [ "$ready" = true ]; then
    echo "  Proxy healthy."
    rm -rf "$stage_dir"
    echo "  Staged copy removed."
  else
    echo "  Warning: proxy did not become healthy within 30s."
    echo "  Staged copy retained: $stage_dir"
    echo "  Check logs: docker exec $CONTAINER_NAME cat /tmp/meridian.log"
  fi

  echo ""
  echo "  Migration complete."
}

cmd_start() {
  require_container

  if proxy_running; then
    echo "  Proxy is already running (PID $(get_proxy_pid))."
    exit 0
  fi

  print_banner "Starting proxy in: $CONTAINER_NAME"
  echo ""

  start_quiet

  # Wait for health
  echo "  Waiting for proxy to be ready..."
  local ready=false
  for i in $(seq 1 30); do
    if health_check; then
      ready=true
      break
    fi
    sleep 1
  done

  echo ""
  if [ "$ready" = true ]; then
    echo "  Proxy is running!"
    echo "  URL:    http://localhost:${HOST_PORT}"
    echo "  Health: http://localhost:${HOST_PORT}/health"
    echo "  Logs:   docker exec $CONTAINER_NAME tail -f /tmp/meridian.log"
  else
    echo "  Warning: Proxy did not become healthy within 30s."
    echo "  Check logs: docker exec $CONTAINER_NAME cat /tmp/meridian.log"
    exit 1
  fi
}

cmd_stop() {
  require_container

  if ! proxy_running; then
    echo "  Proxy is not running."
    exit 0
  fi

  print_banner "Stopping proxy in: $CONTAINER_NAME"

  local pid
  pid=$(get_proxy_pid)
  if [ -n "$pid" ]; then
    docker exec "$CONTAINER_NAME" bash -c "
      pkill -P $pid 2>/dev/null
      kill $pid 2>/dev/null
      rm -f /tmp/meridian-supervisor.pid
      sleep 1
      pkill -9 -P $pid 2>/dev/null
      kill -9 $pid 2>/dev/null
    " 2>/dev/null || true
    echo "  Proxy stopped (PID was $pid)."
  else
    echo "  No PID file found. Proxy may have already stopped."
  fi
}

cmd_restart() {
  require_container

  print_banner "Restarting proxy in: $CONTAINER_NAME"

  stop_quiet
  sleep 1
  start_quiet

  # Wait for health
  echo "  Waiting for proxy to be ready..."
  local ready=false
  for i in $(seq 1 30); do
    if health_check; then
      ready=true
      break
    fi
    sleep 1
  done

  if [ "$ready" = true ]; then
    echo "  Proxy restarted and healthy."
    echo "  URL: http://localhost:${HOST_PORT}"
  else
    echo "  Warning: Proxy did not become healthy within 30s."
    echo "  Check logs: docker exec $CONTAINER_NAME cat /tmp/meridian.log"
  fi
}

cmd_status() {
  print_banner "Meridian VM Status"
  echo ""

  # Collect all meridian-vm containers
  local containers
  containers=$(docker ps -a --filter "name=meridian-vm" --format '{{.Names}}' 2>/dev/null | sort)

  if [ -z "$containers" ]; then
    echo "  No meridian-vm containers found."
    echo ""
    echo "  Get started: $0 create"
    echo "==========================================="
    return
  fi

  printf "  %-20s %-10s %-8s %-8s %-6s %s\n" \
    "CONTAINER" "STATE" "PROXY" "HEALTH" "PORT" "AUTH"
  printf "  %-20s %-10s %-8s %-8s %-6s %s\n" \
    "--------------------" "----------" "--------" "--------" "------" "----"

  for cname in $containers; do
    # Container state
    local cstate
    cstate=$(docker inspect --format '{{.State.Status}}' "$cname" 2>/dev/null || echo "missing")

    # Proxy status
    local proxy_state="stopped"
    if [ "$cstate" = "running" ]; then
      proxy_state=$(docker exec "$cname" bash -c \
        'p=$(cat /tmp/meridian-supervisor.pid 2>/dev/null); [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "running" || echo "stopped"' 2>/dev/null || echo "stopped")
    fi

    # Port
    local mport
    mport=$(get_mapped_port "$cname")
    [ -z "$mport" ] && mport="-"

    # Health
    local health="-"
    if [ "$proxy_state" = "running" ] && [ "$mport" != "-" ]; then
      curl -sf "http://127.0.0.1:${mport}/health" > /dev/null 2>&1 && health="ok" || health="fail"
    fi

    # Auth
    local auth="-"
    if [ "$cstate" = "running" ]; then
      auth=$(docker exec "$cname" bash -c \
        'test -f /home/claude/.claude/.credentials.json && echo "yes" || (test -f /home/claude/.claude.json && echo "yes" || echo "no")' 2>/dev/null || echo "-")
    fi

    printf "  %-20s %-10s %-8s %-8s %-6s %s\n" \
      "$cname" "$cstate" "$proxy_state" "$health" "$mport" "$auth"
  done

  echo ""
  echo "  Commands:"
  echo "    $0 build            Build base image (Node/Bun)"
  echo "    $0 deploy           Full deploy (build+create+setup+auth+install+start)"
  echo "    $0 create           Create new VM container"
  echo "    $0 setup            Install Node/Bun/Claude"
  echo "    $0 auth             Authenticate with Claude"
  echo "    $0 install          Copy project + build"
  echo "    $0 update           Re-sync + rebuild"
  echo "    $0 update-claude    Update claude CLI inside container"
  echo "    $0 start            Start proxy"
  echo "    $0 stop             Stop proxy"
  echo "    $0 restart          Restart proxy"
  echo "    $0 shell            Interactive shell"
  echo "    $0 migrate-tmpfs    Recreate with tmpfs JSONL (preserves /app + auth via docker cp)"
  echo "    $0 delete --force   Remove container"
  echo "==========================================="
}

cmd_shell() {
  require_container

  echo "  Entering shell in '$CONTAINER_NAME' as claude user."
  echo "  Type 'exit' to leave."
  echo ""
  local workdir="/app"
  docker exec "$CONTAINER_NAME" bash -c "test -d $workdir" 2>/dev/null || workdir="/home/claude"
  docker exec -it --user claude -w "$workdir" "$CONTAINER_NAME" bash
}

cmd_root_shell() {
  require_container

  echo "  Entering shell in '$CONTAINER_NAME' as root."
  echo "  Type 'exit' to leave."
  echo ""
  docker exec -it "$CONTAINER_NAME" bash
}

cmd_delete() {
  if ! container_exists; then
    echo "  Container '$CONTAINER_NAME' does not exist."
    exit 0
  fi

  if [ "$FORCE" = false ]; then
    print_banner "Delete container: $CONTAINER_NAME"
    echo ""
    echo "  WARNING: This removes the container and ALL data inside it,"
    echo "  including Claude auth credentials and sessions."
    echo ""
    read -r -p "  Type the container name to confirm: " CONFIRM
    if [ "$CONFIRM" != "$CONTAINER_NAME" ]; then
      echo "  Aborted."
      exit 1
    fi
  fi

  echo "  Removing container '$CONTAINER_NAME'..."
  docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1
  echo "  Removed."
}

cmd_list() {
  echo ""
  echo "  Meridian VM containers:"
  echo ""
  local containers
  containers=$(docker ps -a --filter "name=meridian-vm" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null)
  if [ -n "$containers" ]; then
    echo "$containers" | sed 's/^/  /'
  else
    echo "  (none)"
  fi
  echo ""
}

# ─── Command dispatch ─────────────────────────────────────────────────

dispatch_command() {
  case "$1" in
    build)    cmd_build ;;
    deploy)   cmd_deploy ;;
    create)   cmd_create ;;
    setup)    cmd_setup ;;
    auth)     cmd_auth ;;
    install)  cmd_install ;;
    update)   cmd_update ;;
    update-claude) cmd_update_claude ;;
    start)    cmd_start ;;
    stop)     cmd_stop ;;
    restart)  cmd_restart ;;
    status)   cmd_status ;;
    shell)    cmd_shell ;;
    root-shell) cmd_root_shell ;;
    delete)   cmd_delete ;;
    list)     cmd_list ;;
    migrate-tmpfs) cmd_migrate_tmpfs ;;
    *)
      echo "Error: Unknown command '$1'"
      exit 1 ;;
  esac
}

# Run each action against each instance. Outer loop is IDs so the user
# sees one instance fully processed before the next begins.
if [ ${#INSTANCE_IDS[@]} -gt 1 ]; then
  multi_id=true
else
  multi_id=false
fi
if [ ${#COMMANDS[@]} -gt 1 ]; then
  multi_cmd=true
else
  multi_cmd=false
fi

for _id in "${INSTANCE_IDS[@]}"; do
  resolve_instance_vars "$_id"
  if [ "$multi_id" = true ] || [ "$multi_cmd" = true ]; then
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  Instance: ${CONTAINER_NAME} (port ${HOST_PORT})"
    echo "═══════════════════════════════════════════════════════════"
  fi
  for _cmd in "${COMMANDS[@]}"; do
    if [ "$multi_cmd" = true ]; then
      echo ""
      echo "▶ ${_cmd}"
    fi
    dispatch_command "$_cmd"
  done
done
