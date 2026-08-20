import jwt from 'jsonwebtoken';
import { env } from './env';
import { BadRequestError } from './errors';

const GITHUB_API_BASE = 'https://api.github.com';

// GitHub rejects an App JWT with `exp` more than 10 minutes out. 9 minutes
// leaves margin for clock drift between this server and GitHub's, and for
// however long the JWT sits in flight before it's actually used.
const APP_JWT_TTL_SECONDS = 9 * 60;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

// Installation access tokens are valid for 1 hour. Cached in-process with a
// 5-minute safety margin so a build that takes a while doesn't get handed a
// token that expires mid-clone — and so routine repo-listing calls (which
// can fire several times in a row while a user browses the new-project
// wizard) don't re-mint a fresh token on every single one.
const INSTALLATION_TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;

/** Thrown when GitHub refuses to mint/use an installation token — almost always means the installation was suspended or removed. */
export class GithubAppInstallationError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'GithubAppInstallationError';
  }
}

/**
 * Environment variables store a PEM as a single line with literal `\n`
 * sequences (actual newlines don't survive most .env file formats/loaders
 * intact) — this undoes that so `jwt.sign` gets a real multi-line PEM.
 * A private key that's already got real newlines (e.g. injected via a
 * secrets manager rather than a .env file) passes through unchanged, since
 * there's nothing to replace.
 */
function normalizePrivateKey(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

/**
 * Step 1 of every GitHub App API call: a short-lived JWT signed with the
 * App's own private key, proving "this request comes from the App itself,"
 * not from any particular installation yet. Every call in this file uses
 * this to get an installation-scoped token before doing anything else — the
 * App JWT itself is never used to touch repo contents directly.
 */
function signAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iat: now - 60, // backdated 60s — tolerates the requesting server's clock running slightly ahead of GitHub's
      exp: now + APP_JWT_TTL_SECONDS,
      iss: env.GITHUB_APP_ID,
    },
    normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
    { algorithm: 'RS256' }
  );
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

// Process-local cache only — fine for a single api-server instance, and
// harmless with multiple (worst case, each instance mints its own token;
// GitHub doesn't limit concurrent installation tokens per installation).
const installationTokenCache = new Map<number, CachedToken>();

/**
 * Exchanges the App's identity for a short-lived token scoped to ONE
 * installation — this is the token that actually reads repo contents,
 * lists repos, and (via build-engine's clone step) clones private code.
 * Never the personal OAuth token of whoever happens to be logged in; see
 * docs/deployments/github-app-migration.md for why that distinction is the
 * entire point of this migration.
 */
export async function getInstallationAccessToken(installationId: number): Promise<string> {
  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAtMs - INSTALLATION_TOKEN_SAFETY_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  const res = await fetch(`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signAppJwt()}`,
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    // 404/410 -> installation was uninstalled; 403 -> suspended. Either way
    // the caller (github-repo.service.ts, deployment-engine.ts) should treat
    // this as "this installation can no longer be used," not retry.
    const body = await res.text().catch(() => '');
    throw new GithubAppInstallationError(
      `Could not mint an installation access token (${res.status}): ${body}`,
      res.status === 404 || res.status === 410 ? 'INSTALLATION_NOT_FOUND' : 'INSTALLATION_TOKEN_FAILED'
    );
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  installationTokenCache.set(installationId, { token: data.token, expiresAtMs: Date.parse(data.expires_at) });
  return data.token;
}

/** Drops a cached token — called when a webhook tells us an installation was suspended/removed, so the next call re-checks rather than serving a stale cache entry until it naturally expires. */
export function invalidateInstallationTokenCache(installationId: number): void {
  installationTokenCache.delete(installationId);
}

export interface GithubInstallationDetails {
  id: number;
  account: { login: string; type: string } | null;
  suspended_at: string | null;
}

/**
 * Fetches an installation's own metadata (which account it's on, whether
 * it's suspended) — called right after the install callback redirects back
 * with just an `installation_id`, since that query param alone doesn't tell
 * us WHOSE account was installed on. Uses the App's own JWT directly
 * (`Authorization: Bearer <app jwt>`), not an installation access token —
 * this is metadata about the installation, not a request to act as it.
 */
export async function getInstallationDetails(installationId: number): Promise<GithubInstallationDetails> {
  const res = await fetch(`${GITHUB_API_BASE}/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${signAppJwt()}`,
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new GithubAppInstallationError(
      `Could not fetch installation ${installationId} (${res.status})`,
      'INSTALLATION_NOT_FOUND'
    );
  }

  return res.json() as Promise<GithubInstallationDetails>;
}

export interface GithubAppRepo {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
  html_url: string;
  updated_at: string;
}

/**
 * Every repo the App can currently see for one installation — paginated,
 * GitHub caps this at 100/page. Used by github-repo.service.ts to build the
 * "pick a repo" list in the new-project wizard; the App's own installed-repo
 * set (not the user's personal OAuth repo access) is what defines "which
 * repos can this user import," matching Vercel's own Import flow.
 */
export async function listInstallationRepos(installationId: number): Promise<GithubAppRepo[]> {
  const token = await getInstallationAccessToken(installationId);
  const repos: GithubAppRepo[] = [];
  let page = 1;

  for (;;) {
    const res = await fetch(`${GITHUB_API_BASE}/installation/repositories?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new BadRequestError(`Failed to list installation repositories (${res.status})`, 'GITHUB_APP_LIST_REPOS_FAILED');
    }

    const data = (await res.json()) as { repositories: GithubAppRepo[] };
    repos.push(...data.repositories);

    if (data.repositories.length < 100) break;
    page += 1;
  }

  return repos;
}
