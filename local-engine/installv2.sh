#!/usr/bin/env bash
#
# installv2.sh
#
# Assumes the domain/DNS/TLS work is already done externally.
# This version skips the certificate issuance step entirely and does not
# require --domain or --cloudflare-token arguments.
#
# Expected setup before running this:
#   - .env.deploy already exists and contains DOMAIN
#   - wildcard certs are already mounted under ./certbot/letsencrypt
#   - DNS already points at this box
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="${SCRIPT_DIR}"
# shellcheck source=./scripts/lib/common.sh
source "${SCRIPT_DIR}/scripts/lib/common.sh"

load_existing_domain() {
  local env_file="${APP_ROOT}/.env.deploy"

  if [[ -f "${env_file}" ]]; then
    local domain
    domain="$(grep -E '^DOMAIN=' "${env_file}" | head -n 1 | cut -d= -f2- | tr -d '\r')"
    if [[ -n "${domain}" ]]; then
      echo "${domain}"
      return 0
    fi
  fi

  if [[ -n "${DOMAIN:-}" ]]; then
    echo "${DOMAIN}"
    return 0
  fi

  # Local-device default derived from the preconfigured nginx wildcard setup:
  # server_name *.local.singularitydev.xyz and cert at
  # /etc/letsencrypt/live/local.singularitydev.xyz/...
  echo "local.singularitydev.xyz"
}

DOMAIN="$(load_existing_domain)"
export DOMAIN

require_root
require_command curl
require_command openssl

if [[ ! -f "${APP_ROOT}/.env.deploy" ]]; then
  log_warn "${APP_ROOT}/.env.deploy not found; creating a local-device default config for ${DOMAIN}"
  cat > "${APP_ROOT}/.env.deploy" <<EOF
DOMAIN=${DOMAIN}
POSTGRES_USER=dreamer
POSTGRES_PASSWORD=$(random_hex 24)
MINIO_ROOT_USER=dreamer
MINIO_ROOT_PASSWORD=$(random_hex 24)
S3_BUCKET=dreamer-outputs
NEXT_PUBLIC_API_BASE_URL=https://api.${DOMAIN}
NEXT_PUBLIC_SOCKET_URL=https://api.${DOMAIN}
NEXT_PUBLIC_SITE_URL=https://${DOMAIN}
BUILD_WORKER_CONCURRENCY=5
EOF
  chmod 600 "${APP_ROOT}/.env.deploy"
  if [[ "${EUID}" -eq 0 && -n "${SUDO_USER:-}" ]]; then
    chown "${SUDO_USER}:$(id -gn "${SUDO_USER}")" "${APP_ROOT}/.env.deploy" || true
  fi
fi

echo
log_step "Installing Dreamer Local Engine using the existing domain/TLS configuration"
echo

# --- 1. Docker -----------------------------------------------------------
source "${APP_ROOT}/scripts/lib/install-docker.sh"

# --- 2. Secrets + env files -----------------------------------------------
log_step "Generating any missing secrets and .env files"
POSTGRES_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "${APP_ROOT}/.env.deploy" 2>/dev/null | head -n 1 | cut -d= -f2- | tr -d '\r' || true)"
MINIO_ROOT_PASSWORD="$(grep -E '^MINIO_ROOT_PASSWORD=' "${APP_ROOT}/.env.deploy" 2>/dev/null | head -n 1 | cut -d= -f2- | tr -d '\r' || true)"

if [[ -z "${POSTGRES_PASSWORD}" ]]; then
  POSTGRES_PASSWORD="$(random_hex 24)"
fi
if [[ -z "${MINIO_ROOT_PASSWORD}" ]]; then
  MINIO_ROOT_PASSWORD="$(random_hex 24)"
fi

bash "${APP_ROOT}/scripts/lib/generate-env.sh" "${DOMAIN}" "${POSTGRES_PASSWORD}" "${MINIO_ROOT_PASSWORD}"

# --- 3. TLS / domain setup intentionally skipped ---------------------------
# The domain and wildcard certificate are already assumed to be in place.
log_step "Skipping certificate step: domain and TLS are already configured"

# --- 4. Build the build-engine image --------------------------------------
log_step "Building the build-engine image"
docker build -t dreamer-build-engine:local "${APP_ROOT}/build-engine"

# --- 5. Build + start the stack -------------------------------------------
log_step "Building and starting the stack (this can take a few minutes on first run)"
cd "${APP_ROOT}"
docker compose --env-file .env.deploy up -d --build

# --- 6. Database migrations -----------------------------------------------
log_step "Running database migrations"
attempt=0
until docker compose --env-file .env.deploy run --rm --entrypoint sh api-server -c "npx prisma migrate deploy"; do
  attempt=$((attempt + 1))
  if [[ "${attempt}" -ge 5 ]]; then
    fatal "Migrations failed after 5 attempts — check 'docker compose --env-file .env.deploy logs postgres'"
  fi
  log_warn "Migration attempt ${attempt} failed (Postgres may still be starting) — retrying in 5s..."
  sleep 5
done
log_ok "Migrations applied"

# --- 7. Summary -----------------------------------------------------------
PUBLIC_IP="$(detect_public_ip)"
echo
log_ok "Local Engine is up."
echo
echo "  Dashboard:  https://${DOMAIN}"
echo "  API:        https://api.${DOMAIN}"
echo "  Deployed apps live under: https://<project-slug>.${DOMAIN}"
echo
log_warn "This installer assumes the base domain and wildcard cert are already configured."
log_warn "No --domain and no Cloudflare token are needed for this v2 flow."
log_warn "If you changed your domain setup externally, update .env.deploy and then restart the stack:"
log_warn "  docker compose --env-file .env.deploy up -d --build"
log_warn "  docker compose --env-file .env.deploy restart api-server build-worker"

if [[ -n "${PUBLIC_IP}" && "${PUBLIC_IP}" != "<could-not-detect-fetch-manually-with-curl-ifconfig.me>" ]]; then
  log_warn "Current public IP detected: ${PUBLIC_IP}"
fi
