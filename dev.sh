#!/usr/bin/env bash
set -uo pipefail

# ─── Spatial CMS Dev Service Manager ────────────────────
# Interactive TUI or CLI mode
# Usage:
#   ./dev.sh              Interactive mode (default)
#   ./dev.sh start|stop|restart|status|logs [service]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/.dev-logs"
mkdir -p "$LOG_DIR"

# Service definitions
SVC_NAMES=(db keycloak directus cms viewer workbench)
declare -A SVC_TYPE=( [db]=docker [keycloak]=docker [directus]=docker [cms]=node [viewer]=node [workbench]=node )
declare -A SVC_PORT=( [db]=5434 [keycloak]=8180 [directus]=8055 [cms]=3001 [viewer]=8090 [workbench]=8095 )
declare -A SVC_DESC=( [db]="PostGIS" [keycloak]="Keycloak Auth" [directus]="Directus Admin" [cms]="Express API" [viewer]="Viewer Example" [workbench]="Workbench Example" )
declare -A SVC_URL=( [db]="" [keycloak]="http://localhost:8180" [directus]="http://localhost:8055" [cms]="http://localhost:3001" [viewer]="http://localhost:8090" [workbench]="http://localhost:8095" )
DOCKER_SERVICES=(db keycloak directus)
NODE_SERVICES=(cms viewer workbench)

# Colors
R='\033[0;31m' G='\033[0;32m' Y='\033[0;33m' C='\033[0;36m' B='\033[1m' D='\033[2m' N='\033[0m'

# ─── Core Functions ─────────────────────────────────────

port_pid() { lsof -ti :"$1" 2>/dev/null | head -1; }

svc_status() {
  local svc=$1
  if [[ "${SVC_TYPE[$svc]}" == "docker" ]]; then
    local state
    state=$(docker inspect -f '{{.State.Status}}' "spatial-cms-${svc}-1" 2>/dev/null) || state="stopped"
    [[ "$state" == "running" ]] && echo "running" || echo "stopped"
  else
    [[ -n "$(port_pid "${SVC_PORT[$svc]}")" ]] && echo "running" || echo "stopped"
  fi
}

start_svc() {
  local svc=$1
  local port=${SVC_PORT[$svc]}

  if [[ "$(svc_status "$svc")" == "running" ]]; then
    echo -e "  ${Y}$svc${N} already running (port $port)"
    return
  fi

  if [[ "${SVC_TYPE[$svc]}" == "docker" ]]; then
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d "$svc" > /dev/null 2>&1
    echo -e "  ${G}$svc${N} started (port $port)"
  else
    local log="$LOG_DIR/$svc.log"
    case "$svc" in
      cms)       cd "$SCRIPT_DIR" && nohup npx tsx watch src/index.ts > "$log" 2>&1 & ;;
      viewer)    cd "$SCRIPT_DIR/examples/viewer" && nohup node server.js > "$log" 2>&1 & ;;
      workbench) cd "$SCRIPT_DIR/examples/workbench" && nohup node server.js > "$log" 2>&1 & ;;
    esac
    cd "$SCRIPT_DIR"
    local tries=0
    while [[ -z "$(port_pid "$port")" ]] && (( tries < 30 )); do sleep 0.5; ((tries++)); done
    if [[ -n "$(port_pid "$port")" ]]; then
      echo -e "  ${G}$svc${N} started (port $port)"
    else
      echo -e "  ${R}$svc${N} failed — check $log"
    fi
  fi
}

stop_svc() {
  local svc=$1
  local port=${SVC_PORT[$svc]}

  if [[ "${SVC_TYPE[$svc]}" == "docker" ]]; then
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" stop "$svc" > /dev/null 2>&1
    echo -e "  ${Y}$svc${N} stopped"
  else
    local pids
    pids=$(lsof -ti :"$port" 2>/dev/null)
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill 2>/dev/null
      echo -e "  ${Y}$svc${N} stopped (port $port)"
    else
      echo -e "  ${D}$svc${N} not running"
    fi
  fi
}

# ─── Display ────────────────────────────────────────────

print_status_table() {
  echo ""
  echo -e "  ${B}Spatial CMS Dev Manager${N}"
  echo ""
  printf "  ${D}%-4s${N} %-12s %-16s %-6s %s\n" "#" "SERVICE" "DESCRIPTION" "PORT" "STATUS"
  printf "  ${D}%-4s${N} %-12s %-16s %-6s %s\n" "──" "───────" "──────────" "────" "──────"

  local i=1
  for svc in "${SVC_NAMES[@]}"; do
    local port=${SVC_PORT[$svc]}
    local desc=${SVC_DESC[$svc]}
    local status
    status=$(svc_status "$svc")

    local dot="○" color=$R
    if [[ "$status" == "running" ]]; then
      dot="●" color=$G
    fi

    printf "  ${D}[%d]${N} %-12s %-16s %-6s ${color}%s %s${N}\n" "$i" "$svc" "$desc" "$port" "$dot" "$status"
    ((i++))
  done
  echo ""
}

print_help() {
  echo -e "  ${D}─────────────────────────────────────────${N}"
  echo -e "  ${B}s${N} Start all    ${B}x${N} Stop all    ${B}r${N} Restart all"
  echo -e "  ${B}1-6${N} Toggle service    ${B}l${N} Logs    ${B}q${N} Quit"
  echo ""
}

# ─── Interactive Mode ───────────────────────────────────

interactive() {
  while true; do
    clear
    print_status_table
    print_help
    echo -ne "  ${C}>${N} "
    read -rsn1 key

    case "$key" in
      s)
        echo ""
        echo -e "  ${B}Starting all...${N}"
        docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d > /dev/null 2>&1
        echo -e "  ${G}docker${N} services started"
        for svc in "${NODE_SERVICES[@]}"; do start_svc "$svc"; done
        echo "" && read -rsn1 -p "  Press any key..." ;;
      x)
        echo ""
        echo -e "  ${B}Stopping all...${N}"
        for svc in "${NODE_SERVICES[@]}"; do stop_svc "$svc"; done
        docker compose -f "$SCRIPT_DIR/docker-compose.yml" down > /dev/null 2>&1
        echo -e "  ${Y}docker${N} services stopped"
        echo "" && read -rsn1 -p "  Press any key..." ;;
      r)
        echo ""
        echo -e "  ${B}Restarting all...${N}"
        for svc in "${NODE_SERVICES[@]}"; do stop_svc "$svc"; done
        docker compose -f "$SCRIPT_DIR/docker-compose.yml" down > /dev/null 2>&1
        sleep 1
        docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d > /dev/null 2>&1
        echo -e "  ${G}docker${N} services restarted"
        for svc in "${NODE_SERVICES[@]}"; do start_svc "$svc"; done
        echo "" && read -rsn1 -p "  Press any key..." ;;
      [1-6])
        local idx=$((key - 1))
        local svc="${SVC_NAMES[$idx]}"
        echo ""
        if [[ "$(svc_status "$svc")" == "running" ]]; then
          stop_svc "$svc"
        else
          start_svc "$svc"
        fi
        echo "" && read -rsn1 -p "  Press any key..." ;;
      l)
        clear
        echo ""
        echo -e "  ${B}View logs — press number:${N}"
        local i=1
        for svc in "${SVC_NAMES[@]}"; do
          echo -e "  ${D}[$i]${N} $svc"
          ((i++))
        done
        echo -e "  ${D}[other]${N} cancel"
        echo ""
        echo -ne "  ${C}>${N} "
        read -rsn1 lkey
        if [[ "$lkey" =~ [1-6] ]]; then
          local lsvc="${SVC_NAMES[$((lkey - 1))]}"
          clear
          echo -e "  ${B}Logs: $lsvc${N}  (Ctrl+C to exit)"
          echo -e "  ${D}─────────────────────────────────────────${N}"
          if [[ "${SVC_TYPE[$lsvc]}" == "docker" ]]; then
            docker compose -f "$SCRIPT_DIR/docker-compose.yml" logs -f --tail=30 "$lsvc"
          else
            local log="$LOG_DIR/$lsvc.log"
            if [[ -f "$log" ]]; then
              tail -f -n 30 "$log"
            else
              echo -e "  ${Y}No logs yet. Start the service first.${N}"
              read -rsn1 -p "  Press any key..."
            fi
          fi
        fi ;;
      q)
        echo ""
        echo -e "  ${D}Bye!${N}"
        echo ""
        exit 0 ;;
    esac
  done
}

# ─── CLI Mode ──────────────────────────────────────────

cli_start() {
  local svc=${1:-all}
  if [[ "$svc" == "all" ]]; then
    echo -e "${B}Starting all...${N}"
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d 2>&1 | grep -v "^$" | sed 's/^/  /'
    for s in "${NODE_SERVICES[@]}"; do start_svc "$s"; done
  else
    start_svc "$svc"
  fi
}

cli_stop() {
  local svc=${1:-all}
  if [[ "$svc" == "all" ]]; then
    echo -e "${B}Stopping all...${N}"
    for s in "${NODE_SERVICES[@]}"; do stop_svc "$s"; done
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" down 2>&1 | grep -v "^$" | sed 's/^/  /'
  else
    stop_svc "$svc"
  fi
}

cli_logs() {
  local svc=${1:-}
  if [[ -z "$svc" ]]; then
    echo -e "${R}Usage: ./dev.sh logs <service>${N}"
    echo "Services: ${SVC_NAMES[*]}"
    exit 1
  fi
  if [[ "${SVC_TYPE[$svc]:-}" == "docker" ]]; then
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" logs -f --tail=50 "$svc"
  elif [[ "${SVC_TYPE[$svc]:-}" == "node" ]]; then
    local log="$LOG_DIR/$svc.log"
    [[ -f "$log" ]] && tail -f -n 50 "$log" || echo -e "${Y}No logs yet.${N}"
  else
    echo -e "${R}Unknown: $svc${N}" && exit 1
  fi
}

# ─── Production Deployment (AWS) ────────────────────────
# Configurable via environment variables or edit defaults
PROD_HOST=${PROD_HOST:-13.112.67.185}
PROD_USER=${PROD_USER:-ubuntu}
PROD_SSH_KEY=${PROD_SSH_KEY:-$HOME/.ssh/lightsail-tokyo.pem}
PROD_DOMAIN=${PROD_DOMAIN:-cms.surreal.tools}

cli_deploy_prod() {
  if [[ ! -f "$PROD_SSH_KEY" ]]; then
    echo -e "${R}SSH key not found: $PROD_SSH_KEY${N}"
    echo "Set PROD_SSH_KEY env var or place key at that path."
    exit 1
  fi

  echo -e "${B}Deploying master → production (${PROD_DOMAIN})${N}"
  echo -e "${D}Host: ${PROD_USER}@${PROD_HOST}${N}"
  echo ""

  ssh -i "$PROD_SSH_KEY" -o StrictHostKeyChecking=no "${PROD_USER}@${PROD_HOST}" \
    'cd ~/spatial-cms && ./deploy/scripts/deploy.sh' || {
    echo -e "${R}Deploy failed.${N}"
    exit 1
  }

  echo ""
  echo -e "${B}Verifying...${N}"
  sleep 3
  local health
  health=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://${PROD_DOMAIN}/health")
  if [[ "$health" == "200" ]]; then
    echo -e "  ${G}✓${N} https://${PROD_DOMAIN}/health → 200"
  else
    echo -e "  ${R}✗${N} https://${PROD_DOMAIN}/health → ${health}"
  fi
}

cli_prod_status() {
  echo -e "${B}Production status${N}  (${PROD_DOMAIN})"
  echo ""

  local health auth_config
  health=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://${PROD_DOMAIN}/health")
  auth_config=$(curl -s --max-time 10 "https://${PROD_DOMAIN}/api/v1/auth/config")

  printf "  %-12s " "Health:"
  [[ "$health" == "200" ]] && echo -e "${G}200 OK${N}" || echo -e "${R}${health}${N}"

  printf "  %-12s " "Env:"
  if echo "$auth_config" | grep -q '"isDevelopment":false'; then
    echo -e "${G}production${N}"
  elif echo "$auth_config" | grep -q '"isDevelopment":true'; then
    echo -e "${Y}development${N}"
  else
    echo -e "${R}unknown${N}"
  fi

  printf "  %-12s " "SSH:"
  if ssh -i "$PROD_SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
    "${PROD_USER}@${PROD_HOST}" 'echo ok' > /dev/null 2>&1; then
    echo -e "${G}reachable${N}"
  else
    echo -e "${R}unreachable${N}"
  fi
  echo ""
}

cli_prod_logs() {
  local svc=${1:-cms}
  ssh -i "$PROD_SSH_KEY" -o StrictHostKeyChecking=no "${PROD_USER}@${PROD_HOST}" \
    "cd ~/spatial-cms && sudo docker compose --env-file deploy/.env -f deploy/docker-compose.deploy.yml logs -f --tail=100 $svc"
}

# ─── Entry ──────────────────────────────────────────────

cmd=${1:-}

if [[ -z "$cmd" ]]; then
  interactive
fi

arg=${2:-}
case "$cmd" in
  start)   cli_start "$arg" ;;
  stop)    cli_stop "$arg" ;;
  restart) cli_stop "$arg"; sleep 1; cli_start "$arg" ;;
  status|st) print_status_table ;;
  logs|log) cli_logs "$arg" ;;
  deploy-prod|deploy)  cli_deploy_prod ;;
  prod-status|pst)     cli_prod_status ;;
  prod-logs|plog)      cli_prod_logs "$arg" ;;
  *)
    echo -e "${B}Spatial CMS Dev Manager${N}"
    echo ""
    echo "  Local:"
    echo "    ./dev.sh                    Interactive mode"
    echo "    ./dev.sh start [service]    Start all or one"
    echo "    ./dev.sh stop  [service]    Stop all or one"
    echo "    ./dev.sh restart [service]  Restart"
    echo "    ./dev.sh status             Show status"
    echo "    ./dev.sh logs <service>     Tail logs"
    echo ""
    echo "  Production (AWS):"
    echo "    ./dev.sh deploy-prod        Deploy master → production VM"
    echo "    ./dev.sh prod-status        Check production health"
    echo "    ./dev.sh prod-logs [svc]    Tail production logs (default: cms)"
    echo ""
    echo "  Services: ${SVC_NAMES[*]}"
    echo ""
    echo "  Production env vars (optional overrides):"
    echo "    PROD_HOST     (default: ${PROD_HOST})"
    echo "    PROD_USER     (default: ${PROD_USER})"
    echo "    PROD_SSH_KEY  (default: ${PROD_SSH_KEY})"
    echo "    PROD_DOMAIN   (default: ${PROD_DOMAIN})"
    echo "" ;;
esac
