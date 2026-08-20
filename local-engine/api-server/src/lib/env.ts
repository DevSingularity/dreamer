// single validate config file for env variables
// this is done so every other file imports env, never process.env directly
// due to this, a missing or malformed variable will throw an error on startup instead of at runtime
// we are following a LLD pattern here and avoiding/solving runtime bugs beforehand

import 'dotenv/config';
import { z } from 'zod';

// here we are defining the schema for validation from zod, which is a TypeScript-first schema declaration and validation library
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8000),
  FRONTEND_URL: z.url(),

  // Optional: CORS. FRONTEND_URL alone (plus a hardcoded localhost pair) isn't
  // enough once the dashboard is also opened from Vercel preview
  // deployments — every PR/preview build gets its own subdomain
  // (dreamer-<hash>-<team>.vercel.app), so a static origin list drifts out
  // of date on every single preview deploy and the browser's CORS
  // preflight fails intermittently, exactly matching "works sometimes."
  // CORS_EXTRA_ORIGINS: comma-separated list of additional exact origins to
  // allow (e.g. a staging frontend URL) — optional, on top of FRONTEND_URL
  // and localhost, which are always allowed.
  CORS_EXTRA_ORIGINS: z.string().optional(),
  // CORS_ORIGIN_REGEX: an optional regex (as a string, no slashes) checked
  // against the request Origin header — this is how a whole class of
  // origins (e.g. every Vercel preview URL for this project) is allowed
  // without hardcoding or updating a list on every deploy. Example for a
  // Vercel project named "dreamer" under team "saman-pandey":
  // `^https://dreamer-[a-z0-9]+-saman-pandey\.vercel\.app$`
  CORS_ORIGIN_REGEX: z.string().optional(),

  // COOKIE_DOMAIN: the Domain attribute for the refresh-token and GitHub
  // state cookies. Leave unset only for genuinely cross-site deployments
  // (frontend and API on different registrable domains) or local dev.
  //
  // Strongly prefer setting this. Cookies shared across two DIFFERENT
  // registrable domains only work as SameSite=None third-party cookies,
  // and Safari and Firefox already block third-party cookies by default —
  // Chrome blocks them by default in Incognito and a growing share of
  // regular-mode users opt in to blocking them too. That's the actual
  // cause of "logs in, then immediately bounced to /login?error=session_failed":
  // the refreshToken cookie gets set fine on GitHub's redirect (a top-level
  // navigation), but the SPA's own follow-up `fetch('/api/auth/refresh',
  // {credentials:'include'})` is a cross-site subresource request, and
  // that's exactly the request third-party-cookie blocking targets — the
  // cookie silently never gets sent, every refresh looks like "no session."
  //
  // The fix is DNS/hosting, not code: put the API on a SUBDOMAIN of the
  // same registrable domain as the frontend (e.g. frontend on
  // deploy.yourdomain.com, API on api.yourdomain.com — both under
  // `yourdomain.com`), then set COOKIE_DOMAIN=.yourdomain.com here. Cookies scoped to a shared
  // registrable domain are same-site regardless of subdomain, so they're
  // sent as SameSite=Lax and are NOT subject to third-party-cookie
  // blocking by any browser. See auth.controller.ts's cookie helpers for
  // how this changes SameSite/Secure.
  COOKIE_DOMAIN: z.string().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_CA_CERT: z.string().min(1, 'DATABASE_CA_CERT is required (the PEM contents of your Postgres CA certificate)').optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  // NEW — dedicated Redis instance for BullMQ only (queues + workers).
  // Kept separate from REDIS_URL (ordinary commands: route cache, metrics
  // counters, pub/sub, Streams) specifically so BullMQ's connection count,
  // memory footprint, and eviction policy can be scaled/tuned independently
  // of everything else that touches Redis — see lib/queue.ts's own comment
  // for exactly what "BullMQ work" covers. Optional and falls back to
  // REDIS_URL so existing single-Redis deployments keep working unchanged
  // until REDIS_BUILDER_URL is actually set to something different.
  REDIS_BUILDER_URL: z.string().min(1).optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),

  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes)'),

  // Single GitHub identity for everything: login/signup, account-linking,
  // AND repo access/webhooks. GITHUB_APP_CLIENT_ID/SECRET are the App's own
  // "Identifying and authorizing users" OAuth credentials (github.com App
  // settings page) — used only to resolve who the user is (auth/github.service.ts).
  // Nothing repo-scoped comes from this pair; that's still the installation
  // access token below. There is deliberately no separate GitHub OAuth App
  // anymore — see docs/deployments/github-app-unified-auth.md.
  GITHUB_APP_CLIENT_ID: z.string().min(1, 'GITHUB_APP_CLIENT_ID is required'),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1, 'GITHUB_APP_CLIENT_SECRET is required'),

  // Everything that touches a repo — listing, cloning, webhooks — goes
  // through the App via a per-installation access token (see
  // lib/github-app.ts). See docs/deployments/github-app-migration.md for
  // full setup steps.
  GITHUB_APP_ID: z.string().min(1, 'GITHUB_APP_ID is required'),
  GITHUB_APP_SLUG: z.string().min(1, 'GITHUB_APP_SLUG is required — the "yourapp" in github.com/apps/yourapp'),
  // PEM contents of the App's private key. Literal "\n" sequences are
  // normalized back to real newlines in lib/github-app.ts — most .env
  // loaders can't store an actual multi-line value cleanly.
  GITHUB_APP_PRIVATE_KEY: z.string().min(1, 'GITHUB_APP_PRIVATE_KEY is required'),
  // The ONE webhook secret configured on the App itself — covers every
  // installation, every repo. Nothing per-project to manage; see
  // webhooks/github-webhook.service.ts.
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1, 'GITHUB_APP_WEBHOOK_SECRET is required'),

  // This api-server's own publicly reachable origin — used to build the
  // App's webhook URL (`${API_PUBLIC_URL}/api/webhooks/github`) and the
  // single user-authorization + installation callback URL
  // (`${API_PUBLIC_URL}/api/github-app/callback`). Deliberately separate
  // from FRONTEND_URL (the browser app's origin). Defaults to localhost so
  // local dev boots without extra config; a real
  // deployment needs a real HTTPS URL here or GitHub can't reach either
  // endpoint.
  API_PUBLIC_URL: z.url().default('http://localhost:8000'),

  // NEW — transactional email (verify-email / reset-password links).
  // Required (not optional) since these flows are now mandatory for every
  // email+password signup — an unconfigured deploy should fail at boot,
  // not silently swallow every verification email at runtime.
  RESEND_API_KEY: z.string().min(1, 'RESEND_API_KEY is required'),
  EMAIL_FROM: z.string().min(1, 'EMAIL_FROM is required'), // e.g. "Dreamer <noreply@yourdomain.com>"

  // ── S3-compatible storage — MinIO (bundled in docker-compose.yml),
  // not AWS S3. @aws-sdk/client-s3 is still the client (MinIO speaks the
  // same protocol), but nothing here is a real AWS credential or talks
  // to any real AWS endpoint — see lib/s3-client.ts.
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS_ACCESS_KEY_ID is required (this is your MinIO root user, not a real AWS key)'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS_SECRET_ACCESS_KEY is required (this is your MinIO root password, not a real AWS secret)'),
  S3_BUCKET: z.string().default('dreamer-outputs'),
  // MinIO's endpoint — always set locally (docker-compose.yml's
  // service name), never real AWS's default endpoint resolution.
  S3_ENDPOINT_URL: z.string().min(1, 'S3_ENDPOINT_URL is required — point this at your MinIO endpoint, e.g. http://minio:9000'),
  // MinIO doesn't support virtual-hosted-style bucket addressing
  // (`bucket.host/key`) — only path-style (`host/bucket/key`) — so this
  // is always true here, unlike the cloud schema this was forked from.
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  // ★ NEW — custom domains (domains/custom-domain.service.ts). Same value
  // reverse-proxy's own BASE_DOMAIN env is set to — api-server needs it too
  // now, to build the CNAME target it hands back in DNS instructions and to
  // reject a "custom" domain that's actually just BASE_DOMAIN itself.
  BASE_DOMAIN: z.string().min(1, 'BASE_DOMAIN is required — the domain you own that install.sh set up TLS for'),

  // Optional: automatic TLS for verified custom domains via Render's own
  // Custom Domains API. Not related to build/run at all — this is a
  // separate integration for the case where a USER adds their own custom
  // domain to a project (docs/reverse-proxy/wildcard-domains.md), and has
  // nothing to do with DEPLOYMENT_MODE or where builds run. Left unset on
  // this self-hosted install by default: `install.sh` only issues a
  // certificate for YOUR wildcard domain, not for arbitrary custom
  // domains users add later. When unset, custom-domain.service.ts leaves
  // sslStatus at 'pending' and logs once instead of failing — a domain
  // still verifies and routes correctly over plain HTTP either way, TLS
  // for a customer's own domain is just left manual (issue it yourself
  // with scripts/lib/issue-certificate.sh, the same script install.sh
  // itself uses).
  RENDER_API_KEY: z.string().optional(),
  RENDER_SERVICE_ID: z.string().optional(),

  // ── Local build/run engine ──────────────────────────────────────────
  // Local image tag for build-engine — built once with
  // `docker build -t <this> ./build-engine`. DockerDeploymentEngine's
  // launchBuildTask runs this image with `docker run`.
  DOCKER_BUILD_ENGINE_IMAGE: z.string().min(1, 'DOCKER_BUILD_ENGINE_IMAGE is required — build it first: docker build -t dreamer-build-engine:local ./build-engine'),
  // The compose network build-engine and app containers must join to
  // reach Postgres/Redis/MinIO by service name, and to be reachable FROM
  // reverse-proxy by container name in turn — read at `docker run` time
  // (--network). Deployed app containers publish NO host port at all
  // (see deployDynamicApp): reverse-proxy reaches them container-to-
  // container over this network, same "only nginx publishes a host
  // port" posture as every other service in docker-compose.yml.
  DOCKER_NETWORK: z.string().default('dreamer-local'),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Invalid environment variables:');
    console.error(z.treeifyError(parsed.error));
    process.exit(1);
  }

  return parsed.data;
}

// Validated ONCE, at import time. Every other file imports `env`, not `process.env`,
// so a missing/malformed variable crashes the process at boot — not three requests
// into production when someone finally hits the code path that needed it.
export const env = loadEnv();
