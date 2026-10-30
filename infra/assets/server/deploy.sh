#!/usr/bin/env bash
# Pulls the deploy bundle and restarts the AIRI stack. Runs as root via user data or SSM.
# Usage: deploy.sh   (image tag and URLs are read from SSM parameters)
# Keep LF line endings: bash rejects CRLF (see .gitattributes and test/app-stack.test.ts).
set -euo pipefail

APP_DIR=/opt/airi
SSM_PREFIX=/airi-web
cd "$APP_DIR"

IMDS_TOKEN=$(curl -sfX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
imds() { curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" "http://169.254.169.254/latest/$1"; }
export AWS_REGION=$(imds meta-data/placement/region)
ACCOUNT_ID=$(imds dynamic/instance-identity/document | sed -n 's/.*"accountId" *: *"\([0-9]*\)".*/\1/p')
param() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }

# 1. Refresh compose.yml / Caddyfile / this script from the CDK asset.
aws s3 cp "$(param "$SSM_PREFIX/deploy/bundle-url")" /tmp/airi-bundle.zip --only-show-errors
unzip -oq /tmp/airi-bundle.zip -d "$APP_DIR"
rm -f /tmp/airi-bundle.zip

# 2. Instance-local secrets, generated once and kept with the data they protect.
umask 077
if [[ ! -f secrets.env ]]; then
  DB_PASSWORD=$(openssl rand -hex 24)
  {
    echo "POSTGRES_PASSWORD=$DB_PASSWORD"
    echo "DATABASE_URL=postgres://airi:$DB_PASSWORD@db:5432/airi"
    echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
    echo "LLM_ROUTER_MASTER_KEY=$(openssl rand -base64 32)"
  } > secrets.env
fi

# 3. Operator-managed secrets from SSM SecureString (never written to logs).
REQUIRED_SECURE=(ORIGIN_SECRET AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET AUTH_GITHUB_CLIENT_ID AUTH_GITHUB_CLIENT_SECRET)
aws ssm get-parameters-by-path --path "$SSM_PREFIX/secure" --with-decryption \
  --query 'Parameters[].[Name,Value]' --output text \
  | awk -F'\t' '{ n = split($1, parts, "/"); print parts[n] "=" $2 }' > secure.env.tmp
for KEY in "${REQUIRED_SECURE[@]}"; do
  if ! grep -q "^$KEY=..*" secure.env.tmp; then
    rm -f secure.env.tmp
    echo "Missing SSM SecureString $SSM_PREFIX/secure/$KEY" >&2
    exit 1
  fi
done
# Caddy only needs the origin secret; app containers get everything else.
ORIGIN_SECRET=$(sed -n 's/^ORIGIN_SECRET=//p' secure.env.tmp)
grep -v '^ORIGIN_SECRET=' secure.env.tmp > runtime.env
rm -f secure.env.tmp

IMAGE_TAG=$(param "$SSM_PREFIX/deploy/image-tag")
if [[ "$IMAGE_TAG" == "bootstrap" ]]; then
  echo "Image tag is still 'bootstrap'; skipping start until CI pushes images."
  exit 0
fi

PUBLIC_IP=$(imds meta-data/public-ipv4)
REGISTRY="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
cat > .env <<ENV
IMAGE_REGISTRY=$REGISTRY
IMAGE_TAG=$IMAGE_TAG
PUBLIC_URL=$(param "$SSM_PREFIX/config/public-url")
SITE_HOST=${PUBLIC_IP//./-}.sslip.io
ORIGIN_SECRET=$ORIGIN_SECRET
ENV

# 4. Restart.
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker compose pull --quiet
docker compose up -d --remove-orphans
docker image prune -af --filter "until=168h" >/dev/null
echo "Deployed $IMAGE_TAG"
