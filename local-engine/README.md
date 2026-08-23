# Dreamer — Local Engine

Self-hosted version of Dreamer: same dashboard and API as the cloud
version this was forked from, but every piece — build execution,
object storage, application runtime, TLS — runs on your own VPS via
Docker. There is no AWS SDK, no AWS credential, and no AWS-shaped code
path anywhere in this directory. This isn't "AWS optional" — it's
fully independent of it.

This README is the complete setup guide: what you need before you
start, the one-command install, how the network is deliberately
locked down (Decision 4 in the architecture doc), how to verify it
worked, and how to operate it day to day. There's no external
account to create anywhere in this guide — no GitHub App, no email
provider — see
[`docs/architecture/local-engine-auth-and-networking.md`](docs/architecture/local-engine-auth-and-networking.md)
for why.

---

## Table of contents

1. [What you're setting up](#1-what-youre-setting-up)
2. [Prerequisites](#2-prerequisites)
3. [Quick start](#3-quick-start)
4. [What `install.sh` actually does](#4-what-installsh-actually-does)
5. [Reaching the dashboard (it's not public)](#5-reaching-the-dashboard-its-not-public)
6. [Set your git Personal Access Token](#6-set-your-git-personal-access-token)
7. [Optional: push-to-deploy on `git push`](#7-optional-push-to-deploy-on-git-push)
8. [Verify the install](#8-verify-the-install)
9. [Manual setup (without `install.sh`)](#9-manual-setup-without-installsh)
10. [Day-2 operations](#10-day-2-operations)
11. [Troubleshooting](#11-troubleshooting)
12. [Uninstalling](#12-uninstalling)

---

## 1. What you're setting up

Nine containers, all on one box:

| Service | What it does | Reachable from |
|---|---|---|
| `nginx` | TLS termination for deployed apps + custom domains | The internet, `*.yourdomain.com` only |
| `frontend` | The dashboard (Next.js) | `127.0.0.1:3000` on the VPS only |
| `api-server` | REST API + realtime gateway. Owns the Docker build/run engine. | `127.0.0.1:8000` on the VPS only (plus `/api/webhooks/github`, publicly, only if you turn on push-to-deploy) |
| `build-worker` | Dequeues build jobs, launches `build-engine` containers | Nothing external |
| `build-engine` | *Not* a long-running service — launched fresh per build, exits when done | Nothing external |
| `reverse-proxy` | Routes every deployed app's traffic to MinIO or to its container | Nothing external (nginx proxies to it) |
| `postgres` | Every Project, Deployment, User row | Nothing external |
| `redis` | Build-log pub/sub + a 30s routing cache | Nothing external |
| `minio` | S3-compatible storage for static deployment output | Nothing external |

The dashboard being loopback-only, not public, is deliberate — see
Section 5 and
[`docs/architecture/local-engine-auth-and-networking.md`](docs/architecture/local-engine-auth-and-networking.md)
Decision 4.

---

## 2. Prerequisites

- **A VPS** you have root SSH access to. Ubuntu/Debian assumed
  (`install-docker.sh` uses `apt`). 2 vCPU / 4 GB RAM is a reasonable
  floor — Postgres, Redis, MinIO, and the control-plane services all
  run continuously; each build and each running dynamic app adds to
  that on top.
- **A domain you control**, with access to its DNS. You'll point
  *only* `*.yourdomain.com` (the wildcard) at the VPS's IP — the bare
  apex is left alone, so an existing site there (Vercel, Netlify,
  whatever) keeps working untouched.
- **Ports 80 and 443 open** to the internet on that VPS. Check your
  cloud provider's firewall/security-group rules, not just the OS
  firewall (this trips people up more often than the OS side does).
- Optional but strongly recommended: **a Cloudflare-managed zone**
  for your domain, so TLS issuance can be fully unattended (see
  Section 4). Without it, you'll do one interactive step during
  install.

**TLDR;** Everything runs on your box. No GitHub App, no email
provider account — nothing external to sign up for.

---

## 3. Quick start

```bash
git clone https://github.com/SamanPandey-in/dreamer.git
cd dreamer/local-engine
sudo ./install.sh --domain yourdomain.com --cloudflare-token YOUR_CF_TOKEN
```

No Cloudflare token? Drop the flag — `install.sh` falls back to an
interactive certificate flow (it'll pause and show you a DNS TXT
record to create by hand). Either way, when it finishes the whole
stack is up and ready to deploy — no external account left to set
up. Continue to Section 5 to actually reach the dashboard.

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
   the stored git PAT undecryptable). Delete a specific file yourself
   first if you genuinely want it regenerated.
3. **Obtains a wildcard-only TLS certificate** for `*.yourdomain.com`
   — necessarily via DNS-01, since HTTP-01 challenges can't prove
   ownership of a wildcard at all, and deliberately NOT including the
   bare apex (nothing on this box serves it — see Section 1). With
   `--cloudflare-token` this is fully unattended; without one,
   certbot runs interactively and waits for you to create a TXT
   record it shows you.
4. **Builds the `build-engine` image** (`dreamer-build-engine:local`).
   This is deliberately not a long-running compose service — it's
   launched on demand, per build.
5. **Brings up the full stack** — `docker compose up -d --build`.
6. **Runs database migrations** (`prisma migrate deploy`), retrying up
   to 5 times in case Postgres is still starting.
7. **Installs a daily cron job** (`/etc/cron.d/...`) that runs
   `scripts/renew-certs.sh` — a no-op on most days; certbot only
   actually renews within 30 days of expiry.
8. **Prints a summary**: how to reach the dashboard (an SSH tunnel
   command, ready to copy-paste) and a reminder that the git PAT and
   push-to-deploy webhook are both optional, in-app, next steps —
   Sections 6 and 7.

---

## 5. Reaching the dashboard (it's not public)

The dashboard has no public hostname at all — see
[`docs/architecture/local-engine-auth-and-networking.md`](docs/architecture/local-engine-auth-and-networking.md)
Decision 4 for why. From your own machine:

```bash
ssh -L 3000:localhost:3000 -L 8000:localhost:8000 root@your-vps-ip
```

Leave that running, then open **http://localhost:3000** in your own
browser. The first thing you'll see is the one-time setup screen —
name, email, password — this creates the single admin account
(`POST /api/auth/setup`), and only ever works once: reload the page
after and you'll get the normal login screen instead.

Want the dashboard reachable without an SSH tunnel every time (a
Tailscale/VPN address, or you've decided the stricter default isn't
worth it for your setup)? That's a deliberate deviation from what
this repo ships by default — see the architecture doc's note under
Decision 4 for the trade-off, then add your own `nginx` server block
or docker-compose port binding for it.

---

## 6. Set your git Personal Access Token

Optional, and only needed to deploy **private** repos — public repos
clone and deploy with no token at all.

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** (or classic, either works) → Generate new
   token.
2. Scope: **Contents: Read-only** is enough (plus **Metadata:
   Read-only**, which fine-grained tokens require automatically). If
   you also want [push-to-deploy](#7-optional-push-to-deploy-on-git-push)
   to auto-register its webhook for you later, add **Webhooks:
   Read and write** too — otherwise you'll add the webhook by hand in
   Section 7, which needs no extra scope.
3. In the dashboard: **Settings → Git** → paste the token → Save. It's
   encrypted at rest (AES-256-GCM) the same way env vars are.

That's it — no separate "connect your GitHub account" step, no App
installation. The wizard's repo picker and the build worker both use
this one token from here on.

---

## 7. Optional: push-to-deploy on `git push`

Off by default — manual **Redeploy** from the dashboard always works
regardless of this section. Turn this on only if you want a push to
automatically trigger a build.

1. Generate a shared secret: `openssl rand -hex 32`.
2. Add it to `api-server/.env`:
   ```
   GITHUB_WEBHOOK_SECRET=<the value you just generated>
   ENABLE_PUSH_DEPLOY=true
   API_PUBLIC_URL=https://hooks.yourdomain.com
   ```
3. Add the matching line to `.env.deploy` (read by `docker-compose.yml`
   directly, not by the app):
   ```
   ENABLE_PUSH_DEPLOY=true
   ```
4. Restart the containers that need to pick this up:
   ```bash
   docker compose --env-file .env.deploy up -d nginx api-server build-worker
   ```
5. On the repo itself — GitHub → Settings → Webhooks → Add webhook:
   - Payload URL: `https://hooks.yourdomain.com/api/webhooks/github`
   - Content type: `application/json`
   - Secret: the same value from step 1
   - Events: just **Pushes**

`hooks.yourdomain.com` is covered by the wildcard cert you already
have (`*.yourdomain.com`) — nothing extra to issue. See
[`docs/architecture/local-engine-auth-and-networking.md`](docs/architecture/local-engine-auth-and-networking.md)
Decision 3 & 4 for exactly what this does and doesn't expose.

---

## 8. Verify the install

```bash
docker compose --env-file .env.deploy ps
```

All nine services should show `Up` (or `Up (healthy)` for the three
with healthchecks: postgres, redis, minio).

- With the SSH tunnel from Section 5 open, visit
  `http://localhost:3000` — the setup screen (first run) or login
  screen should load.
- Log in, connect a repository (Section 6 first, if it's private),
  and deploy it. For a static site, once `RUNNING`, check the object
  landed in MinIO:
  ```bash
  docker compose --env-file .env.deploy exec minio \
    mc ls local/dreamer-outputs/__outputs/<your-project-slug>/
  ```
- For a Next.js (SSR) deploy, confirm a container came up:
  ```bash
  docker ps --filter "name=dreamer-app-"
  ```
  and that `https://<project-slug>.yourdomain.com` actually renders
  — publicly, over the internet, with no tunnel needed (this is the
  one thing that's SUPPOSED to be public — see Section 1).

If everything above works, the install is genuinely done — this is
the real end-to-end verification, not just "the containers are
running."

Two specific things worth watching closely on this first real run, if
you're setting this up right after the auth/git-PAT migration
([`docs/architecture/local-engine-auth-and-networking.md`](docs/architecture/local-engine-auth-and-networking.md)):
that code was type-checked end to end but never actually executed
against a live Postgres/Docker daemon before now.

- **The setup wizard actually round-trips.** Submitting it should log
  you straight into `/dashboard` with no error — if it doesn't,
  `docker compose --env-file .env.deploy logs api-server` around the
  `POST /api/auth/setup` call is the first place to look.
- **A private-repo build actually authenticates with the PAT.** Set a
  token (Section 6), deploy a private repo, and confirm the build
  clones successfully rather than failing on a 404/403 partway
  through — that's `getSingleOperatorGitAccessToken()`
  (`lib/git-credentials.ts`) actually reaching the build container
  correctly, not just type-checking correctly.

Neither is expected to fail — the logic mirrors the login flow's
existing, previously-working session code and the PAT-as-clone-
credential pattern is about as standard as it gets — but "type-checks
clean" and "actually works against a real Postgres and a real GitHub
API call" are different guarantees, and this is the first time this
code has faced the second one.

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
Rotating `ENCRYPTION_KEY` specifically makes the stored git PAT
undecryptable — you'll need to re-enter it in Settings.

---

## 11. Troubleshooting

**`api-server` won't accept connections from your browser**
Confirm your SSH tunnel is actually up (`ssh -L 3000:localhost:3000
-L 8000:localhost:8000 ...`, Section 5) and that you're opening
`http://localhost:3000`, not a public hostname — there isn't one for
the dashboard by design.

**TLS issuance fails / times out**
Almost always DNS: the certbot DNS-01 challenge needs your domain's
nameservers to actually be Cloudflare's (for `--cloudflare-token`) or
you need to have correctly created the TXT record it showed you (for
the manual flow) *before* pressing Enter, and given it a minute to
propagate.

**Forgot the admin password**
No email-based reset (see Decision 1) — reset it directly from the server:
```bash
docker compose --env-file .env.deploy exec api-server \
  npx tsx scripts/reset-admin-password.ts your-new-password
```
This also signs out every existing session for the account, same as a
normal in-app password change does.

**"Set a git Personal Access Token in Settings" when deploying a private repo**
Expected — see Section 6. Public repos need no token at all.

**A push to GitHub doesn't trigger a redeploy**
First check `ENABLE_PUSH_DEPLOY=true` is actually set in both
`api-server/.env` AND `.env.deploy` (nginx reads the latter) and that
you restarted `nginx`/`api-server`/`build-worker` after setting it —
see Section 7. Then check **Webhook → Recent Deliveries** on the
repo's own webhook settings page — a non-2xx response there tells you
exactly what was rejected (usually a secret mismatch between
`GITHUB_WEBHOOK_SECRET` and what you pasted into GitHub's form).

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
