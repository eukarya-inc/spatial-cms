#!/usr/bin/env bash
# Reset RDS master password manually, disable AWS-managed rotation,
# sync VM .env, restart cms + keycloak containers.
# Password is generated locally (alphanumeric, 32 chars), never logged.

set -euo pipefail

REGION='ap-northeast-1'
RDS_ID='spatial-cms'
VM_USER='ubuntu'
VM_HOST='13.112.67.185'
SSH_KEY="$HOME/.ssh/lightsail-tokyo.pem"
LOCAL_SECRETS="$HOME/projects/spatial-cms/deploy/.deployment_secrets.txt"

echo "Generating new password locally…"
NEW_PW=$(python3 -c "import secrets,string; a=string.ascii_letters+string.digits; print(''.join(secrets.choice(a) for _ in range(32)))")
[ ${#NEW_PW} -ne 32 ] && { echo "ERROR: bad password length ${#NEW_PW}"; exit 1; }
echo "  generated (length ${#NEW_PW})"

echo "Modifying RDS: --no-manage-master-user-password + set new password…"
aws rds modify-db-instance \
  --region "$REGION" \
  --db-instance-identifier "$RDS_ID" \
  --no-manage-master-user-password \
  --master-user-password "$NEW_PW" \
  --apply-immediately > /dev/null
echo "  modify request submitted"

echo "Waiting for RDS to apply (poll every 10s)…"
for i in $(seq 1 40); do
  STATUS=$(aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$RDS_ID" \
    --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || echo "unknown")
  PENDING=$(aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$RDS_ID" \
    --query 'DBInstances[0].PendingModifiedValues.MasterUserPassword' --output text 2>/dev/null || echo "None")
  echo "  attempt $i: status=$STATUS pendingPassword=$PENDING"
  if [ "$STATUS" = "available" ] && [ "$PENDING" = "None" ] && [ "$i" -ge 2 ]; then
    break
  fi
  sleep 10
done

echo "Buffer wait 15s for password propagation…"
sleep 15

echo "Updating VM .env + recreating cms + keycloak…"
printf '%s' "$NEW_PW" | ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${VM_USER}@${VM_HOST}" 'bash -s' <<'REMOTE'
set -euo pipefail
NEW=$(cat)
cd ~/spatial-cms
cp deploy/.env "deploy/.env.bak.B.$(date +%s)"
sed -i.tmp "s|^RDS_PASSWORD=.*|RDS_PASSWORD=${NEW}|" deploy/.env
rm -f deploy/.env.tmp
echo "  env updated"
docker compose -f deploy/docker-compose.deploy.yml --env-file deploy/.env up -d --force-recreate cms keycloak
echo "  containers recreated, waiting 25s…"
sleep 25
docker ps --format "  {{.Names}}\t{{.Status}}"
echo "---cms logs (last 30s)---"
docker compose -f deploy/docker-compose.deploy.yml --env-file deploy/.env logs cms --tail=15 --since=40s 2>&1 | grep -E "running|Authentication|prisma:error|Error" | head -8 || echo "(no errors found in cms logs)"
REMOTE

echo ""
echo "Verifying public endpoint…"
sleep 3
curl -s -o /tmp/h.txt -w "  public /health: %{http_code}\n" https://cms.surreal.tools/health
cat /tmp/h.txt; echo

echo ""
echo "Appending password to $LOCAL_SECRETS (gitignored)…"
{
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  RDS master password reset: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "  --no-manage-master-user-password (rotation DISABLED)"
  echo "═══════════════════════════════════════════════════════════"
  echo "  User     : cms_admin"
  echo "  Password : $NEW_PW"
  echo "  Endpoint : spatial-cms.c3cgcyck0veo.ap-northeast-1.rds.amazonaws.com"
  echo "═══════════════════════════════════════════════════════════"
} >> "$LOCAL_SECRETS"
echo "  done"
