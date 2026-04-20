#!/bin/bash
# Deploy / redeploy Spatial CMS on the VM
# 在 VM 上一键部署或更新
#
# Usage (run from project root on the VM):
#   ./deploy/scripts/deploy.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$DEPLOY_DIR")"

cd "$PROJECT_ROOT"

if [ ! -f "$DEPLOY_DIR/.env" ]; then
  echo "✗ deploy/.env not found. Copy deploy/.env.example and fill in values."
  exit 1
fi

echo "→ Pulling latest code..."
git pull

echo "→ Pulling base images..."
docker compose --env-file "$DEPLOY_DIR/.env" -f "$DEPLOY_DIR/docker-compose.deploy.yml" pull

echo "→ Building CMS image..."
docker compose --env-file "$DEPLOY_DIR/.env" -f "$DEPLOY_DIR/docker-compose.deploy.yml" build cms

echo "→ Starting services..."
docker compose --env-file "$DEPLOY_DIR/.env" -f "$DEPLOY_DIR/docker-compose.deploy.yml" up -d

echo ""
echo "✓ Deployed. Check logs:"
echo "   docker compose --env-file $DEPLOY_DIR/.env -f $DEPLOY_DIR/docker-compose.deploy.yml logs -f"
