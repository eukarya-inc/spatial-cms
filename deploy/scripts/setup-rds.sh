#!/bin/bash
# Setup RDS for Spatial CMS
# 初始化 RDS：创建 spatial_cms + keycloak 数据库，启用 PostGIS
#
# Usage:
#   ./setup-rds.sh <RDS_HOST> <ADMIN_USER> <ADMIN_PASSWORD>
#
# Example:
#   ./setup-rds.sh my-db.xxx.ap-northeast-1.rds.amazonaws.com spatial_cms_admin 'p@ssw0rd'
#
# Prerequisites:
#   - RDS Publicly accessible: Yes (临时，之后关闭)
#   - Security group 允许本地 IP 访问 5432
#   - 本地有 psql 命令

set -e

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <RDS_HOST> <ADMIN_USER> <ADMIN_PASSWORD>"
  exit 1
fi

RDS_HOST=$1
ADMIN_USER=$2
ADMIN_PASSWORD=$3

echo "Setting up databases on ${RDS_HOST}..."

# 创建业务数据库和 Keycloak 数据库
PGPASSWORD="$ADMIN_PASSWORD" psql -h "$RDS_HOST" -U "$ADMIN_USER" -d postgres <<EOF
CREATE DATABASE spatial_cms;
CREATE DATABASE keycloak;
EOF

# 在 spatial_cms 里启用 PostGIS 扩展
PGPASSWORD="$ADMIN_PASSWORD" psql -h "$RDS_HOST" -U "$ADMIN_USER" -d spatial_cms <<EOF
CREATE EXTENSION IF NOT EXISTS postgis;
SELECT PostGIS_Version();
EOF

echo ""
echo "✓ Databases created:"
echo "  - spatial_cms (with PostGIS)"
echo "  - keycloak"
echo ""
echo "Next steps:"
echo "  1. Run Prisma migrations from project root:"
echo "     DATABASE_URL=\"postgresql://${ADMIN_USER}:PASS@${RDS_HOST}:5432/spatial_cms?schema=public\" \\"
echo "       npx prisma migrate deploy"
echo ""
echo "  2. In AWS Console, set RDS 'Publicly accessible: No' and restrict security group"
