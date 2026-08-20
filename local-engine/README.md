# Dreamer — Local Engine

Self-hosted version of Dreamer: same dashboard and API as the cloud
version this was forked from, but every piece — build execution,
object storage, application runtime, TLS — runs on your own VPS via
Docker. There is no AWS SDK, no AWS credential, and no AWS-shaped code
path anywhere in this directory. This isn't "AWS optional" — it's
fully independent of it.

This README is the complete setup guide: what you need before you
start, the one-command install, the one thing that install can't
automate for you (a GitHub App), how to verify it worked, and how to
operate it day to day.

---

## Table of contents

1. [What you're setting up](#1-what-youre-setting-up)
2. [Prerequisites](#2-prerequisites)
3. [Quick start](#3-quick-start)
4. [What `install.sh` actually does](#4-what-installsh-actually-does)
5. [Create a GitHub App](#5-create-a-github-app)
6. [Create a Resend account](#6-create-a-resend-account)
7. [Finish activating the API server](#7-finish-activating-the-api-server)
8. [Verify the install](#8-verify-the-install)
9. [Manual setup (without `install.sh`)](#9-manual-setup-without-installsh)
10. [Day-2 operations](#10-day-2-operations)
11. [Troubleshooting](#11-troubleshooting)
12. [Uninstalling](#12-uninstalling)

---

## 1. What you're setting up

Nine containers, all on one box:

| Service | What it does |
|---|---|
| `nginx` | TLS termination + the only container that publishes a port to the internet |
| `frontend` | The dashboard (Next.js) |
| `api-server` | REST API + realtime gateway. Owns the Docker build/run engine. |
| `build-worker` | Dequeues build jobs, launches `build-engine` containers |
| `build-engine` | *Not* a long-running service — launched fresh per build, exits when done |
| `reverse-proxy` | Routes every deployed app's traffic to MinIO or to its container |
| `postgres` | Every Project, Deployment, User row |
| `redis` | Build-log pub/sub + a 30s routing cache |
| `minio` | S3-compatible storage for static deployment output |

---

## 2. Prerequisites

- **A VPS** you have root SSH access to. Ubuntu/Debian assumed
  (`install-docker.sh` uses `apt`). 2 vCPU / 4 GB RAM is a reasonable
  floor — Postgres, Redis, MinIO, and the control-plane services all
  run continuously; each build and each running dynamic app adds to
  that on top.
- **A domain you control**, with access to its DNS. You'll point
  `yourdomain.com` and `*.yourdomain.com` at the VPS's IP.
- **Ports 80 and 443 open** to the internet on that VPS. Check your
  cloud provider's firewall/security-group rules, not just the OS
  firewall (this trips people up more often than the OS side does).
- Optional but strongly recommended: **a Cloudflare-managed zone**
  for your domain, so TLS issuance can be fully unattended (see
  Section 4). Without it, you'll do one interactive step during
  install.

**TLDR;** Everything runs on your box.

---

## 3. Quick start

```bash
git clone https://github.com/SamanPandey-in/dreamer.git
cd dreamer/local-engine
sudo ./install.sh --domain deploy.yourdomain.com --cloudflare-token YOUR_CF_TOKEN
```

No Cloudflare token? Drop the flag — `install.sh` falls back to an
interactive certificate flow (it'll pause and show you a DNS TXT
record to create by hand). Either way, when it finishes you'll have a
running stack with one thing left to fill in: a GitHub App (Section
5) and a Resend API key (Section 6) — both require an account only
you can create, so no script can do this part for you.

---

## 4. What `install.sh` actually does

Worth understanding before you run it as root, not just trusting it
blindly:

1. **Installs Docker** if it isn't already present.
2. **Generates every secret** the stack needs — Postgres password,
   MinIO root password, JWT signing keys, the token-encryption key —
   and writes `.env.deploy`, `api-server/.env`, `reverse-proxy/.env`.
   This step **refuses to overwrite** any of those three files if
   they already exist, specifically so re-running `install.sh` never
   silently rotates `JWT_ACCESS_SECRET` or `ENCRYPTION_KEY` out from
   under a running instance (that would log everyone out and make
   every already-stored GitHub token undecryptable). Delete a
   specific file yourself first if you genuinely want it regenerated.
3. **Obtains a wildcard TLS certificate** for `yourdomain.com` *and*
   `*.yourdomain.com` in one certificate (a plain wildcard cert
   doesn't cover the bare apex domain, and the dashboard lives on the
   apex) — necessarily via DNS-01, since HTTP-01 challenges can't
   prove ownership of a wildcard at all. With `--cloudflare-token`
   this is fully unattended; without one, certbot runs interactively
   and waits for you to create a TXT record it shows you.
4. **Builds the `build-engine` image** (`dreamer-build-engine:local`).
   This is deliberately not a long-running compose service — it's
   launched on demand, per build.
5. **Brings up the full stack** — `docker compose up -d --build`.
6. **Runs database migrations** (`prisma migrate deploy`), retrying up
   to 5 times in case Postgres is still starting.
7. **Installs a daily cron job** (`/etc/cron.d/...`) that runs
   `scripts/renew-certs.sh` — a no-op on most days; certbot only
   actually renews within 30 days of expiry.
8. **Prints a summary**: your dashboard/API URLs, a reminder to point
   DNS at the box if you haven't, and a reminder that `api-server`
   will crash-loop until you complete Sections 5 and 6 below.

---

## 5. Create a GitHub App

This is the one piece `install.sh` can't do for you — it needs an
account and a manual creation step on GitHub's side. Everything below
maps directly to fields the app validates at boot
(`api-server/src/lib/env.ts`) — if one of these is wrong or missing,
`api-server` will refuse to start and tell you exactly which field.

1. Go to **github.com/settings/apps/new** (for a personal account) or
   your organization's equivalent.
2. **GitHub App name**: anything unique on GitHub — this becomes part
   of your install URL.
3. **Homepage URL**: `https://yourdomain.com` (your dashboard).
4. **Callback URL**: `https://api.yourdomain.com/api/github-app/callback`
   — check **"Request user authorization (OAuth) during
   installation."**
5. **Webhook** → Active: checked.
   **Webhook URL**: `https://api.yourdomain.com/api/webhooks/github`
   **Webhook secret**: generate one yourself (`openssl rand -hex 32`)
   and keep it — you'll paste the same value into both GitHub's form
   and `api-server/.env`'s `GITHUB_APP_WEBHOOK_SECRET`.
6. **Permissions** — Repository permissions:
   - **Contents: Read-only** (needed to clone a repo)
   - **Metadata: Read-only** (GitHub requires this on every App; it's
     pre-selected)

   Account permissions:
   - **Email addresses: Read-only** (login reads the user's verified
     primary email through this permission — GitHub Apps don't use
     classic OAuth scopes, so this checkbox is what stands in for one)
7. **Subscribe to events** — check exactly these three:
   - `push`
   - `installation`
   - `installation_repositories`

   (These are the only three events the webhook handler processes;
   subscribing to others is harmless but pointless.)
8. **Where can this GitHub App be installed?** — "Any account" if you
   want other people to be able to install it on their own repos too;
   "Only on this account" if it's just for you.
9. Click **Create GitHub App**.

After creation, on the App's settings page:

- **App ID** (top of the page) → `GITHUB_APP_ID`
- **Client ID** → `GITHUB_APP_CLIENT_ID`
- **Client secret** → click "Generate a new client secret" →
  `GITHUB_APP_CLIENT_SECRET`
- The app's slug — the part of the URL after `github.com/apps/` →
  `GITHUB_APP_SLUG`
- **Private key** → "Generate a private key" downloads a `.pem` file.
  Open it and paste the *entire* contents (including the
  `-----BEGIN/END-----` lines) as `GITHUB_APP_PRIVATE_KEY`. If your
  `.env` loader can't store real newlines cleanly, literal `\n`
  sequences are fine — `lib/github-app.ts` normalizes them back.
- The webhook secret you generated in step 5 → `GITHUB_APP_WEBHOOK_SECRET`

Put all six values into `api-server/.env` (see Section 7).

---

## 6. Create a Resend account

Email verification and password-reset links are mandatory parts of
the sign-up flow — `api-server` won't boot without a working
`RESEND_API_KEY`, by design (`env.ts` fails fast on a missing required
var rather than silently dropping every verification email at
runtime).

1. Sign up at **resend.com**.
2. Add and verify a sending domain (Resend walks you through the DNS
   records — SPF/DKIM — you add at your DNS provider). This can be
   the same domain you're already using, or a subdomain of it.
3. Create an API key → paste it as `RESEND_API_KEY` in
   `api-server/.env`.
4. Set `EMAIL_FROM` to an address on your verified domain, e.g.
   `Dreamer <dreamer@yourdomain.com>` — `install.sh` already filled
   this in with a sensible default; only change it if you verified a
   different domain than the one you installed under.

---

## 7. Finish activating the API server

```bash
cd local-engine
$EDITOR api-server/.env
```

Fill in the six `GITHUB_APP_*` fields (Section 5) and `RESEND_API_KEY`
(Section 6) — every other field was already generated by `install.sh`.
Then:

```bash
docker compose --env-file .env.deploy restart api-server build-worker
docker compose --env-file .env.deploy logs -f api-server
```

You should see it start cleanly with no "Invalid environment
variables" error. If you do see that error, it names the exact field
that's missing or malformed — fix it and restart again.

---

## 8. Verify the install

```bash
docker compose --env-file .env.deploy ps
```

All nine services should show `Up` (or `Up (healthy)` for the three
with healthchecks: postgres, redis, minio).

- Visit `https://yourdomain.com` — the dashboard should load over a
  valid certificate.
- Sign up with email/password — you should receive a verification
  email (confirms Resend is wired correctly).
- "Continue with GitHub" on the login page — should redirect to
  GitHub and back cleanly (confirms the GitHub App's OAuth callback
  is correct).
- Connect a repository and deploy it. For a static site, once
  `RUNNING`, check the object landed in MinIO:
  ```bash
  docker compose --env-file .env.deploy exec minio \
    mc ls local/dreamer-outputs/__outputs/<your-project-slug>/
  ```
- For a Next.js (SSR) deploy, confirm a container came up:
  ```bash
  docker ps --filter "name=dreamer-app-"
  ```
  and that `https://<project-slug>.yourdomain.com` actually renders.

If everything above works, the install is genuinely done — this is
the real end-to-end verification, not just "the containers are
running."

---

## 9. Manual setup (without `install.sh`)

If you'd rather not run a script as root, or you're setting this up
on infrastructure `install.sh` doesn't expect (no `apt`, TLS handled
some other way already):

```bash
cd local-engine

# 1. Root-level compose vars
cp .env.deploy.example .env.deploy
$EDITOR .env.deploy          # set DOMAIN, POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD

# 2. Per-service envs
cp api-server/.env.example api-server/.env
$EDITOR api-server/.env      # see Sections 5–7 above for the fields that need real values

cp reverse-proxy/.env.example reverse-proxy/.env
$EDITOR reverse-proxy/.env   # just POSTGRES_PASSWORD, matching .env.deploy

# 3. Build the on-demand build-engine image
docker build -t dreamer-build-engine:local build-engine

# 4. TLS — nginx's config references cert files unconditionally, so this
#    has to happen BEFORE bringing nginx up, however you get the certs:
./scripts/lib/issue-certificate.sh yourdomain.com you@yourdomain.com [cloudflare-token]

# 5. Bring up the stack
docker compose --env-file .env.deploy up -d --build

# 6. Migrate
docker compose --env-file .env.deploy run --rm --entrypoint sh api-server \
  -c "npx prisma migrate deploy"

# 7. Cert renewal — install.sh's cron job, or run this yourself periodically
./scripts/renew-certs.sh yourdomain.com
```

---

## 10. Day-2 operations

**Logs** (any service):
```bash
docker compose --env-file .env.deploy logs -f api-server
docker compose --env-file .env.deploy logs -f build-worker
```

**Restart a service** after changing its `.env`:
```bash
docker compose --env-file .env.deploy restart api-server build-worker
```

**Update to a new version of the code**:
```bash
git pull
docker compose --env-file .env.deploy up -d --build
docker compose --env-file .env.deploy run --rm --entrypoint sh api-server \
  -c "npx prisma migrate deploy"   # only needed if the update includes a schema migration
```

**Rebuild the build-engine image** (if `build-engine/` itself changed):
```bash
docker build -t dreamer-build-engine:local build-engine
```

**Back up Postgres**:
```bash
docker compose --env-file .env.deploy exec postgres \
  pg_dump -U dreamer dreamer > backup-$(date +%F).sql
```

**Back up MinIO** (deployment output — regenerable by redeploying,
but faster to restore from a backup than to rebuild everything):
```bash
docker run --rm -v <this-repo>/local-engine_minio_data:/data -v "$(pwd)":/backup \
  alpine tar czf /backup/minio-backup-$(date +%F).tar.gz -C /data .
```

**Rotate a secret** (e.g. you suspect `ENCRYPTION_KEY` leaked): edit
`api-server/.env` directly, restart `api-server`/`build-worker`.
Rotating `ENCRYPTION_KEY` specifically makes every previously-stored
GitHub token undecryptable — users will need to reconnect GitHub.

---

## 11. Troubleshooting

**`api-server` crash-loops with "Invalid environment variables"**
Expected right after a fresh `install.sh` run, before you've done
Sections 5–7 — the error names the exact missing field. Fix
`api-server/.env` and restart.

**TLS issuance fails / times out**
Almost always DNS: the certbot DNS-01 challenge needs your domain's
nameservers to actually be Cloudflare's (for `--cloudflare-token`) or
you need to have correctly created the TXT record it showed you (for
the manual flow) *before* pressing Enter, and given it a minute to
propagate.

**Dashboard loads but GitHub login redirects to an error**
Check the GitHub App's **Callback URL** matches `API_PUBLIC_URL`
exactly (`https://api.yourdomain.com/api/github-app/callback`) — a
trailing slash or `http` vs `https` mismatch is the usual culprit.

**A push to GitHub doesn't trigger a redeploy**
Check **Webhook → Recent Deliveries** on the GitHub App's settings
page — a non-2xx response there tells you exactly what
`api-server` rejected it for (usually a webhook-secret mismatch,
meaning `GITHUB_APP_WEBHOOK_SECRET` doesn't match what you entered on
GitHub's side).

**A deploy is stuck in `BUILDING` forever**
```bash
docker ps -a --filter "name=dreamer-build-"
docker logs dreamer-build-<deployment-id>
```
The build container's own logs (not `api-server`'s) show what
actually failed inside the build — a bad install/build command, a
missing `output: 'standalone'` for a dynamic Next.js app, etc.

**A dynamic app deploy fails but the previous version is still live**
This is by design (Section 4.3 of the architecture doc) — a new
container that never passes its health check is discarded and the
previous one is left running. Check `docker logs
dreamer-app-<slug>-staging-*` for why the new one didn't come up
(most commonly: the app doesn't bind to `0.0.0.0:3000`, or crashes on
a missing env var).

**Ran out of disk space**
Old build-engine containers and unused images accumulate. Clean up
with:
```bash
docker system prune -f
docker image prune -af
```

---

## 12. Uninstalling

```bash
cd local-engine
docker compose --env-file .env.deploy down -v   # -v also removes named volumes (Postgres/Redis/MinIO data — irreversible)
rm -rf certbot/letsencrypt
rm /etc/cron.d/dreamer-local-engine-cert-renewal
```

Omit `-v` if you might come back — that flag deletes every database,
deployment output, and running app's data permanently.
