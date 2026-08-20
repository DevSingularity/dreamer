import { env } from '../lib/env';
import { BadRequestError } from '../lib/errors';

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_BASE = 'https://api.github.com';

export interface GithubProfile {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string;
}

interface GithubEmail {
    email: string;
    primary: boolean;
    verified: boolean;
}

/**
 * Step 1 of the IDENTITY-ONLY flow — where we send the browser to ask the
 * user to authorize (or re-authorize) this App's OAuth identity
 * (`https://github.com/login/oauth/authorize`). Used for "Continue with
 * GitHub" login/signup (githubRedirectHandler) and Settings' "Connect
 * GitHub" account-linking (githubConnectRedirectHandler). NEVER shows the
 * repo-picker/install screen and must not be used for granting repo access
 * — see buildGithubInstallUrl for that. GitHub's own docs describe the
 * relationship as installation driving OAuth, not the other way around:
 * "If you select Request user authorization (OAuth) during installation
 * ... step 1 [this redirect] will be completed DURING app installation."
 * (https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps#identifying-users-on-your-site)
 *
 * There is deliberately no `scope` param — a GitHub App's permissions come
 * from its own configuration (Account permissions → Email addresses, etc.),
 * not from OAuth scopes.
 */
export function buildGithubAuthorizeUrl(state: string): string {
    return `https://github.com/login/oauth/authorize?client_id=${env.GITHUB_APP_CLIENT_ID}&state=${encodeURIComponent(state)}`;
}

/**
 * The App's install URL — the ONLY GitHub entry point that actually shows
 * the repo-picker, and the only place a user can pick WHICH account/org to
 * install on (or add a new org alongside their personal account). Used by
 * the repo-access flow (github-app-install.controller.ts's
 * githubAppInstallRedirectHandler) — every "Connect GitHub" / "grant access
 * to more repos" entry point in the New Project wizard.
 *
 * Because the App has "Request user authorization (OAuth) during
 * installation" enabled (see docs/deployments/github-app-unified-auth.md),
 * GitHub layers the OAuth handshake on top of this automatically and the
 * shared callback still receives a `code` — no separate call to
 * buildGithubAuthorizeUrl is needed or correct here. Do not swap this for
 * buildGithubAuthorizeUrl: that URL never triggers an install, so a user
 * who already has an OAuth authorization on file (e.g. from a prior login)
 * would silently round-trip with a `code` and no `installation_id` —
 * "connected" in the URL, nothing actually installed.
 *
 * Known GitHub limitation if the App is ALREADY installed on the chosen
 * account: GitHub shows a "Configure" (add/remove repos) screen instead and
 * does not redirect back through the callback afterward — not fixable
 * client-side (https://github.com/orgs/community/discussions/163512). The
 * `installation_repositories` webhook keeps our data correct regardless;
 * the frontend should just tell the user to come back once they're done
 * rather than assume an automatic round trip.
 */
export function buildGithubInstallUrl(state: string): string {
    return `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;
}

/** Step 2 — exchange the short-lived `code` GitHub redirected back with, for an access token. */
export async function exchangeCodeForToken(code: string): Promise<string> {
    const response = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            client_id: env.GITHUB_APP_CLIENT_ID,
            client_secret: env.GITHUB_APP_CLIENT_SECRET,
            code,
            // No redirect_uri here: GitHub only requires it when a GitHub
            // App/OAuth App has MULTIPLE callback URLs registered. This App
            // has exactly one ("Callback URL" in its settings), so GitHub
            // uses that automatically — matching what the App is actually
            // configured to redirect to.
        }),
    });

    const data = (await response.json()) as { access_token?: string; error?: string };

    if (!response.ok || !data.access_token) {
        throw new BadRequestError(
            `GitHub token exchange failed: ${data.error ?? 'unknown error'}`,
            'GITHUB_AUTH_FAILED'
        );
    }

    return data.access_token;
}

/** Step 3 — fetch the GitHub profile of the user who just authorized us. */
export async function fetchGithubProfile(accessToken: string): Promise<GithubProfile> {
    const response = await fetch(`${GITHUB_API_BASE}/user`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });

    if (!response.ok) {
        throw new BadRequestError('Failed to fetch GitHub profile', 'GITHUB_AUTH_FAILED');
    }

    return response.json() as Promise<GithubProfile>;
}

/**
 * Whether the user who owns `accessToken` (a personal, user-to-server
 * token — see exchangeCodeForToken) has explicit access to a given App
 * installation. /user/installations only ever lists installations the
 * authenticated user personally has read/write/admin on — unlike the App
 * JWT (lib/github-app.ts's signAppJwt), which can look up ANY installation
 * of this App regardless of who's asking. This is what lets
 * linkInstallationIfPresent (github-app-install.controller.ts) reject an
 * installation_id that was reused from someone else's callback/query
 * string instead of trusting it outright.
 *
 * Paginated defensively (most users have 1-2 installations, but an org
 * admin could have many) and capped so a pathological account can't turn
 * one callback into unbounded GitHub API calls.
 */
const MAX_INSTALLATION_PAGES = 10;

export async function userCanAccessInstallation(accessToken: string, installationId: number): Promise<boolean> {
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
        const response = await fetch(`${GITHUB_API_BASE}/user/installations?per_page=100&page=${page}`, {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
        });

        if (!response.ok) return false;

        const data = (await response.json()) as { installations: { id: number }[] };
        if (data.installations.some((installation) => installation.id === installationId)) return true;
        if (data.installations.length < 100) return false;
    }

    return false;
}

/**
 * GitHub's primary email can be private — /user omits it in that case, so we
 * need the dedicated /user/emails endpoint. For a GitHub App user token this
 * requires the App's "Email addresses: Read-only" account permission to be
 * granted (see docs/deployments/github-app-unified-auth.md) rather than an
 * OAuth scope — GitHub Apps don't use classic OAuth scopes at all.
 *
 * We only ever return a VERIFIED email. A verified email is the one safe
 * signal we can use to auto-link a GitHub login to an existing password
 * account — an unverified email could be typed in by anyone and doesn't
 * prove ownership of that inbox.
 */
export async function fetchPrimaryVerifiedGithubEmail(accessToken: string): Promise<string | null> {
    const response = await fetch(`${GITHUB_API_BASE}/user/emails`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' },
    });

    if (!response.ok) return null;

    const emails = (await response.json()) as GithubEmail[];
    const primary = emails.find((e) => e.primary && e.verified);

    return primary?.email ?? null;
}