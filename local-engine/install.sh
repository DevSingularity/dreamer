#!/usr/bin/env bash
#
# ./install.sh --domain yourdomain.com [--email you@yourdomain.com] [--cloudflare-token TOKEN]
#
# Single command that takes a fresh VPS to a running Dreamer Local Engine:
# installs Docker if missing, generates every secret this stack needs,
# obtains a wildcard TLS certificate, builds the build-engine image,
# and brings up Postgres, Redis, MinIO, api-server, build-worker,
# frontend, reverse-proxy, and nginx — all as containers on THIS box.
# No AWS account, no managed cloud Postgres/Redis/S3 needed anywhere.
#
# What this does NOT do for you (can't — requires an account/app only you
# can create): a GitHub App. Gets a clearly-marked TODO placeholder in the
# generated api-server/.env; see the summary this script prints at the end.
#
# Deliberately mirrors the repo root's own scripts/install.sh step-for-step
# (same flag names, same ordering, same cert-before-nginx / migrate-after-up
# reasoning) — anyone who's already self-hosted the cloud version's control
# plane will recognize this immediately.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./scripts/lib/common.sh
source "${SCRIPT_DIR}/scripts/lib/common.sh"

DOMAIN=""
EMAIL=""
CLOUDFLARE_TOKEN=""

usage() {
  cat <<EOF
Usage: $0 --domain yourdomain.com [--email you@yourdomain.com] [--cloudflare-token TOKEN]

  --domain            Required. The apex domain you control, e.g. deploy.yourdomain.com
                       (no "https://", no leading "*.", no subdomain).
  --email              Optional. Used for Let's Encrypt expiry notices.
                       Defaults to admin@<domain>.
  --cloudflare-token   Optional. A Cloudflare API token (Zone:DNS:Edit
                       scope, on the zone for --domain) — enables a fully
                       unattended wildcard certificate via DNS-01.
                       Omit this and the script falls back to an
                       INTERACTIVE manual DNS-01 flow instead.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --cloudflare-token) CLOUDFLARE_TOKEN="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) log_error "Unknown argument: $1"; usage; exit 1 ;;
  esac
done

validate_domain "${DOMAIN}"
EMAIL="${EMAIL:-admin@${DOMAIN}}"

require_root
require_command curl
require_command openssl

echo
log_step "Installing Dreamer Local Engine on this box for domain: ${DOMAIN}"
echo

# --- 1. Docker -----------------------------------------------------------
source "${SCRIPT_DIR}/scripts/lib/install-docker.sh"

# --- 2. Secrets + env files ------------------------------------------------
log_step "Generating secrets and .env files"
POSTGRES_PASSWORD="$(random_hex 24)"
MINIO_ROOT_PASSWORD="$(random_hex 24)"
bash "${SCRIPT_DIR}/scripts/lib/generate-env.sh" "${DOMAIN}" "${POSTGRES_PASSWORD}" "${MINIO_ROOT_PASSWORD}"

# --- 3. TLS certificate (BEFORE bringing nginx up — same reasoning as the
# repo root's own install.sh: nginx's config already references cert
# files unconditionally and fails to start without them) -----------------
log_step "Obtaining wildcard TLS certificate for ${DOMAIN} and *.${DOMAIN}"
bash "${SCRIPT_DIR}/scripts/lib/issue-certificate.sh" "${DOMAIN}" "${EMAIL}" "${CLOUDFLARE_TOKEN}"

# --- 4. Build the build-engine image --------------------------------------
# NOT a compose service (see docker-compose.yml's own comment) —
# DockerDeploymentEngine runs it on-demand per build with `docker run`,
# same role ECS RunTask plays in the cloud version. Has to exist before
# the first deploy is attempted, so build it here rather than leaving it
# as a manual step someone forgets.
log_step "Building the build-engine image"
docker build -f "${SCRIPT_DIR}/build-engine/Dockerfile.local" -t dreamer-build-engine:local "${SCRIPT_DIR}/build-engine"

# --- 5. Build + start the stack -------------------------------------------
log_step "Building and starting the stack (this can take a few minutes on first run)"
cd "${SCRIPT_DIR}"
docker compose --env-file .env.deploy up -d --build

# --- 6. Database migrations ------------------------------------------------
# `docker compose run` (not `exec`), same reasoning as the repo root's own
# install.sh: a fresh one-off container from the api-server image, not the
# long-running service, which may well be crash-looping right now on the
# still-empty GITHUB_APP_* placeholders — expected at this point, not a bug.
log_step "Running database migrations"
attempt=0
until docker compose --env-file .env.deploy run --rm --entrypoint sh api-server -c "npx prisma migrate deploy"; do
  attempt=$((attempt + 1))
  if [[ "${attempt}" -ge 5 ]]; then
    fatal "Migrations failed after 5 attempts — check 'docker compose logs postgres'"
  fi
  log_warn "Migration attempt ${attempt} failed (Postgres may still be starting) — retrying in 5s..."
  sleep 5
done
log_ok "Migrations applied"

# --- 7. Certificate auto-renewal --------------------------------------------
log_step "Installing a daily renewal cron job"
CRON_FILE="/etc/cron.d/dreamer-local-engine-cert-renewal"
echo "0 3 * * * root ${SCRIPT_DIR}/scripts/renew-certs.sh ${DOMAIN} >> /var/log/dreamer-local-engine-cert-renewal.log 2>&1" > "${CRON_FILE}"
chmod 644 "${CRON_FILE}"
log_ok "Wrote ${CRON_FILE} (runs daily at 03:00; certbot itself only actually renews within 30 days of expiry)"

# --- 8. Summary --------------------------------------------------------------
PUBLIC_IP="$(detect_public_ip)"
echo
log_ok "Install complete."
echo
echo "  Dashboard:  https://${DOMAIN}"
echo "  API:        https://api.${DOMAIN}"
echo "  Deployed apps live under: https://<project-slug>.${DOMAIN}"
echo
log_warn "Point ${DOMAIN} and *.${DOMAIN} at this box's IP (${PUBLIC_IP}) if you haven't already."
log_warn "api-server/.env still has TODO placeholders for your GitHub App — the api-server"
log_warn "container will crash-loop until those are filled in. See api-server/.env.example"
log_warn "for the exact steps, then: docker compose --env-file .env.deploy restart api-server build-worker"
