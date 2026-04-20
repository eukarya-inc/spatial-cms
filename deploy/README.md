# Spatial CMS — AWS Deployment Kit

Deploy a production instance of Spatial CMS on AWS. Designed for single-tenant deployment: each team runs their own independent stack.

## Architecture

```
Internet (HTTPS)
    ↓
┌─────────────────────────────────┐
│  Lightsail VM  (~$10/month)     │
│  ┌───────────────────────────┐  │
│  │ Caddy — reverse proxy     │  │
│  │        auto Let's Encrypt │  │
│  │ CMS   — Express + UI      │  │
│  │ Keycloak — authentication │  │
│  └───────────────────────────┘  │
└──────────────┬──────────────────┘
               ↓ (private connection)
┌─────────────────────────────────┐
│  RDS PostgreSQL 17 + PostGIS    │
│  (~$15/month)                   │
│  - spatial_cms database         │
│  - keycloak database            │
│  - Automatic daily backups      │
└─────────────────────────────────┘
```

**Separation of concerns:**
- **Compute (Lightsail VM)** — stateless. Can be stopped/recreated without data loss.
- **Data (RDS)** — stateful. Managed backups, scalable storage, independent lifecycle.

## Cost (Tokyo region, USD/month)

| State | Cost |
|-------|------|
| Running continuously | **~$25** |
| VM stopped, RDS running | ~$20 |
| Both stopped (RDS auto-restarts after 7 days) | ~$5 |
| Add weekly snapshot | +$3 |

## Prerequisites

- **AWS account** with billing enabled
- **Domain name** (Route 53 or external)
- **Local tools**: `aws` CLI, `psql`, `git`, `ssh`
- **Familiarity**: basic command line, Docker concepts

## Phase A: AWS Account Setup

### A1. Secure the root user
1. Log in as root, enable **MFA** (Authenticator app).
2. Lock the root credentials in a password manager. Never use root for daily work.

### A2. Create an IAM user for yourself
1. IAM → Users → Create user `admin-deployer`
2. Attach `AdministratorAccess` policy (MVP shortcut)
3. Enable MFA, generate an access key
4. Install AWS CLI locally: `aws configure` with the access key

Verify: `aws sts get-caller-identity` returns the IAM user ARN.

### A3. Set up billing alerts
CloudWatch → Alarms → Billing → threshold $30 (warning) and $50 (critical). Send to your email.

## Phase B: Data Layer (RDS)

### B1. Create RDS instance

AWS Console → RDS → Create database

| Setting | Value |
|---------|-------|
| Engine | PostgreSQL 17.x |
| Template | Dev/Test |
| Instance | db.t4g.micro (ARM, cheapest) |
| Storage | gp3, 20GB, **enable storage autoscaling** (max 100GB) |
| Multi-AZ | No (MVP) |
| VPC | default |
| **Public access** | **Yes** (temporary — for initial setup only) |
| Security group | new: `sg-rds` |
| Master username | `spatial_cms_admin` |
| Master password | **Managed in Secrets Manager** (check the option) |
| Backup retention | 7 days |
| Encryption | Enabled (default) |

Wait ~10 minutes. Note the **endpoint** (e.g. `xxx.ap-northeast-1.rds.amazonaws.com`).

### B2. Temporarily allow your local IP

Edit security group `sg-rds` → Inbound → add rule:
- Port 5432, source: `YOUR_PUBLIC_IP/32` (get it with `curl ifconfig.me`)

### B3. Retrieve the master password

AWS Console → Secrets Manager → find the RDS secret → Retrieve secret value.

### B4. Initialize databases

```bash
./deploy/scripts/setup-rds.sh \
  <RDS_ENDPOINT> \
  spatial_cms_admin \
  '<PASSWORD_FROM_SECRETS_MANAGER>'
```

This creates `spatial_cms` and `keycloak` databases, enables PostGIS extension.

### B5. Run Prisma migrations

From the project root (local machine):

```bash
DATABASE_URL="postgresql://spatial_cms_admin:PASSWORD@RDS_ENDPOINT:5432/spatial_cms?schema=public" \
  npx prisma migrate deploy
```

Verify migrations applied: `npx prisma migrate status`

### B6. Close public access

1. AWS Console → RDS → Modify → **Public access: No** → Apply immediately
2. Security group `sg-rds` → remove the temporary rule with your IP
3. (Later in Phase D, we'll add a rule allowing only the VM)

## Phase C: Domain and DNS

### C1. Get a domain
- **Option 1**: Buy via Route 53 (~$12/year for .com) — automatically creates hosted zone
- **Option 2**: Use existing domain → create Route 53 hosted zone → update NS records at current registrar

Don't create the A record yet — we need the VM's IP first.

## Phase D: Compute Layer (Lightsail)

### D1. Create Lightsail instance

AWS Console → Lightsail → Create instance

| Setting | Value |
|---------|-------|
| Region | Tokyo (ap-northeast-1) |
| OS | Ubuntu 22.04 LTS |
| Plan | **$10/mo (2GB RAM, 1 vCPU, 60GB SSD)** |

### D2. Attach static IP

Lightsail → Networking → Create static IP → attach to the instance. (Static IPs are free if attached.)

Note the IP address.

### D3. Configure firewall

Lightsail instance → Networking → Firewall:
- Port 22 (SSH) — default allowed
- Port 80 (HTTP) — **add**
- Port 443 (HTTPS) — **add**

### D4. Create DNS A record

Route 53 → Hosted zone → Create record:
- Type: A
- Name: `cms` (for `cms.yourdomain.com`)
- Value: Lightsail static IP
- TTL: 300

Verify: `dig cms.yourdomain.com` returns your Lightsail IP (may take a few minutes).

### D5. Allow VM → RDS connection

Security group `sg-rds` → Inbound → add rule:
- Port 5432, source: `<VM_STATIC_IP>/32`

## Phase E: Deploy

### E1. SSH to the VM

```bash
ssh -i <LIGHTSAIL_KEY>.pem ubuntu@<VM_STATIC_IP>
```

(Download the default key from Lightsail → Account → SSH keys.)

### E2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu
newgrp docker

# Restrict Docker log growth
sudo tee /etc/docker/daemon.json > /dev/null <<EOF
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
sudo systemctl restart docker
```

### E3. Clone repository

```bash
git clone https://github.com/eukarya-inc/spatial-cms.git
cd spatial-cms
```

### E4. Configure environment

```bash
cp deploy/.env.example deploy/.env
nano deploy/.env
```

Fill in:
- `DOMAIN` — e.g. `cms.yourdomain.com`
- `RDS_HOST` — your RDS endpoint
- `RDS_USER` — `spatial_cms_admin`
- `RDS_PASSWORD` — from Secrets Manager
- `KEYCLOAK_ADMIN_PASSWORD` — generate: `openssl rand -base64 32`

Secure the file: `chmod 600 deploy/.env`

### E5. Start services

```bash
./deploy/scripts/deploy.sh
```

First start takes ~2 minutes (Caddy requests HTTPS cert from Let's Encrypt, Keycloak initializes realm).

Check logs:
```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.deploy.yml logs -f
```

### E6. Verify

```bash
curl -I https://cms.yourdomain.com/health
# HTTP/2 200
```

Browser:
1. Open `https://cms.yourdomain.com/`
2. Click login → redirects to Keycloak
3. Default test users from realm JSON (admin/admin, editor/editor, reviewer/reviewer)
4. After login → CMS dashboard

### E7. Bootstrap API key

```bash
curl -X POST https://cms.yourdomain.com/api/v1/api-keys/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"name":"deployment-admin","scope":"admin"}'
```

**Save the returned key** — it's shown only once. Store it in a password manager.

## Phase F: Backup and Recovery

### F1. Automated backups (already enabled)

RDS takes daily snapshots automatically. Point-in-time recovery within the retention window (7 days).

### F2. Manual snapshot before demos

```bash
aws rds create-db-snapshot \
  --db-instance-identifier <your-rds-name> \
  --db-snapshot-identifier pre-demo-$(date +%Y%m%d)
```

Manual snapshots don't expire (delete them when no longer needed to save cost).

### F3. Recovery drill (do this once!)

**Untested backups are not backups.** Practice restoring:

1. RDS → Automated backups → select your instance → Restore to point in time
2. Create a new instance from that snapshot (`<name>-restore-test`)
3. Connect to it: `psql "postgresql://spatial_cms_admin:PASSWORD@NEW_ENDPOINT:5432/spatial_cms"`
4. Verify data exists: `SELECT COUNT(*) FROM entity;`
5. Delete the restore instance (to save cost)
6. Document the procedure in your runbook

## Phase G: Cost Optimization

### G1. Stop VM when not in use

```bash
# Stop (preserves everything, no compute cost)
aws lightsail stop-instance --instance-name <your-instance>

# Start before next demo (~1-2 minutes to be ready)
aws lightsail start-instance --instance-name <your-instance>
```

Static IP is retained; no DNS changes needed.

### G2. Stop RDS if idle for long

```bash
aws rds stop-db-instance --db-instance-identifier <your-rds-name>
# Auto-restarts after 7 days (AWS policy)
```

## Operations

### Updating the deployment

On the VM:
```bash
cd spatial-cms
./deploy/scripts/deploy.sh
```

This pulls latest git, rebuilds the CMS image, restarts services.

### Viewing logs

```bash
cd spatial-cms
docker compose --env-file deploy/.env -f deploy/docker-compose.deploy.yml logs -f cms
docker compose --env-file deploy/.env -f deploy/docker-compose.deploy.yml logs -f keycloak
```

### Rotating secrets

1. Generate new password
2. Update in Secrets Manager (for DB) or `.env` (for Keycloak admin)
3. Restart affected services

### Database direct access

From the VM:
```bash
docker run --rm -it postgres:17 psql \
  "postgresql://spatial_cms_admin:PASSWORD@RDS_HOST:5432/spatial_cms"
```

## Troubleshooting

**Caddy can't get HTTPS cert**
- Check DNS A record is correct: `dig cms.yourdomain.com`
- Check ports 80/443 are open in Lightsail firewall
- Wait 2-5 minutes; Let's Encrypt has rate limits

**Keycloak boot failure**
- Check RDS is reachable from VM: `nc -zv RDS_HOST 5432`
- Check `keycloak` database exists
- Check `KC_HOSTNAME` matches your domain exactly (https:// prefix!)

**CMS can't connect to DB**
- Check security group allows VM → RDS on 5432
- Check DATABASE_URL format in `.env`
- Try from VM: `docker run --rm postgres:17 pg_isready -h RDS_HOST -p 5432`

**Login loop / JWT errors**
- `KEYCLOAK_URL` in CMS env must match Keycloak's issuer URL
- If domain changed, Keycloak needs restart to pick up new `KC_HOSTNAME`

## Verification Checklist

- [ ] AWS account root has MFA, IAM user for daily use
- [ ] Billing alerts configured
- [ ] RDS instance running with PostGIS 3.x
- [ ] RDS public access disabled, sg locked to VM only
- [ ] Prisma migrations applied (`npx prisma migrate status` clean)
- [ ] Manual RDS snapshot + restore drill completed
- [ ] Lightsail VM running with static IP
- [ ] Domain A record resolves to VM IP
- [ ] `https://<domain>/health` returns 200
- [ ] Keycloak login works end-to-end
- [ ] CMS dashboard loads after login
- [ ] API key bootstrap succeeded
- [ ] VM stop/start tested
- [ ] Cost in AWS Cost Explorer ~$25/month
