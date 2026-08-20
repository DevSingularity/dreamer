import type { Request, Response } from 'express';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import * as authService from '../auth/auth.service';
import { REFRESH_COOKIE_NAME, setRefreshCookie, stateCookieSecure } from '../auth/auth.controller';
import {
  buildGithubInstallUrl,
  exchangeCodeForToken,
  fetchGithubProfile,
  fetchPrimaryVerifiedGithubEmail,
  userCanAccessInstallation,
} from '../auth/github.service';
import { getInstallationDetails } from '../lib/github-app';
import {
  signGithubFlowState,
  verifyGithubFlowState,
  GITHUB_STATE_COOKIE_NAME,
  GITHUB_CALLBACK_PATH,
  type SessionMeta,
} from '../auth/auth.tokens';

function sessionMeta(req: Request): SessionMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

/**
 * GET /api/github-app/install — an already-logged-in user granting/adding
 * repo access (a first install, another org alongside their personal
 * account, etc.) from the New Project wizard, without re-running the full
 * login dance. The browser navigates here directly (a link/button, not a
 * fetch call), so there's no Authorization header to check the way
 * requireAuth normally would — identity instead comes from the same
 * httpOnly refresh-token cookie every other cookie-based flow in this app
 * uses.
 *
 * MUST send the browser to the App's own install URL
 * (buildGithubInstallUrl → github.com/apps/{slug}/installations/new), NOT
 * buildGithubAuthorizeUrl (github.com/login/oauth/authorize). These are two
 * different GitHub entry points and are not interchangeable:
 *   - /login/oauth/authorize only ever runs the OAuth identity handshake.
 *     It never shows the repo-picker/install screen, even for a user who
 *     has never installed the App — GitHub's own docs describe the
 *     relationship the other way around ("If you select Request user
 *     authorization (OAuth) during installation ... step 1 [the OAuth
 *     redirect] will be completed DURING app installation" —
 *     https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps#identifying-users-on-your-site).
 *     If someone had already authorized this App's OAuth identity before
 *     (e.g. from a prior "Continue with GitHub" login), hitting this URL
 *     again just silently round-trips a `code` with no `installation_id`
 *     and no picker — which is exactly the "URL says connected, nothing
 *     ever got installed" bug this route used to have.
 *   - /apps/{slug}/installations/new is the only URL that actually shows
 *     the picker. Because the App has "Request user authorization (OAuth)
 *     during installation" enabled (see docs/deployments/github-app-unified-auth.md),
 *     GitHub layers the OAuth handshake on top of it automatically and
 *     lands back on the exact same shared callback with `code` AND
 *     `installation_id` — one round trip, no separate authorize step
 *     needed here.
 *
 * Known GitHub limitation, not fixable from this codebase: if the App is
 * ALREADY installed on the account/org the user picks, GitHub shows a
 * "Configure" (add/remove repos) screen instead of a fresh install, and
 * does NOT redirect back through the callback afterward — see
 * https://github.com/orgs/community/discussions/163512. The
 * `installation_repositories` webhook (github-webhook.service.ts) still
 * keeps our data correct in that case; the frontend just can't assume a
 * same-tab round trip and should prompt the user to come back once done.
 *
 * Identity is resolved via authService.resolveUserFromRefreshToken, NOT
 * authService.refresh — this route is a plain GET with no CSRF token (a
 * cross-site top-level navigation or embed can trigger it), so it must not
 * have a side effect that mutates server state. refresh() rotates the
 * session as a matter of course; resolveUserFromRefreshToken only reads
 * who the cookie belongs to and leaves the existing session untouched.
 */
export async function githubAppInstallRedirectHandler(req: Request, res: Response) {
  const rawRefreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!rawRefreshToken) {
    // Logged purely for diagnosis: this fires both for a genuinely
    // logged-out user AND for a browser still holding a pre-fix
    // refreshToken cookie scoped to path=/api/auth (which this route,
    // /api/github-app/install, never receives). Since a same-name cookie
    // at a different path isn't visible here at all, we can't tell the two
    // cases apart server-side — this line just makes the failure mode
    // visible if it shows up more than expected post-deploy.
    logger.info('github-app install redirect: no refreshToken cookie present', {
      hasCookieHeader: Boolean(req.headers.cookie),
    });
    return res.redirect(`${env.FRONTEND_URL}/login?error=github_app_install_requires_login`);
  }

  let userId: string;
  try {
    const user = await authService.resolveUserFromRefreshToken(rawRefreshToken);
    userId = user.id;
  } catch {
    return res.redirect(`${env.FRONTEND_URL}/login?error=github_app_install_requires_login`);
  }

  const state = signGithubFlowState({ intent: 'install', userId, returnTo: '/dashboard/new' });

  // 'lax', same reasoning as auth.controller.ts's state cookie: GitHub's
  // redirect back is a cross-site TOP-LEVEL navigation, and 'strict' would
  // silently not be sent on it, breaking the CSRF check below.
  res.cookie(GITHUB_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: stateCookieSecure(),
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: GITHUB_CALLBACK_PATH,
  });

  res.redirect(buildGithubInstallUrl(state));
}

/**
 * Links (or refreshes) one GithubInstallation row for a resolved user —
 * shared by all three intents below. A no-op when GitHub didn't include an
 * installation_id (e.g. a 'login' pass where the user only re-authorized
 * without touching their installation). Malformed IDs are ignored rather
 * than failing the whole login/connect — the identity half of the callback
 * already succeeded by the time this runs, and that's the half a user is
 * actually blocked without.
 *
 * Ownership is checked with the resolved user's OWN GitHub token before
 * anything is persisted: getInstallationDetails below authenticates with
 * the App JWT, which can look up ANY installation of this App by ID, so on
 * its own an installation_id proves nothing about who it belongs to.
 * installation_id arrives on a query string an attacker could replay
 * against a different, authenticated session, so without this check that
 * attacker could bind another account's installation to their own.
 * userCanAccessInstallation calls GET /user/installations, which only ever
 * lists installations the token's owner has explicit access to.
 */
async function linkInstallationIfPresent(userId: string, githubAccessToken: string, installationIdParam?: string): Promise<void> {
  if (!installationIdParam) return;
  const installationId = Number(installationIdParam);
  if (!Number.isInteger(installationId)) return;

  if (!(await userCanAccessInstallation(githubAccessToken, installationId))) {
    logger.warn("Rejected installation link: not visible to this user's GitHub token", { userId, installationId });
    return;
  }

  const details = await getInstallationDetails(installationId);

  await prisma.githubInstallation.upsert({
    where: { installationId },
    // `create` covers the first install; `update` covers this same user (or
    // this same installation via a different flow) re-running the dance —
    // GitHub can redirect back through this exact callback more than once
    // with the SAME installation_id, so this must be idempotent rather than
    // erroring on a duplicate.
    create: {
      installationId,
      accountLogin: details.account?.login ?? 'unknown',
      accountType: details.account?.type ?? 'User',
      userId,
    },
    update: {
      accountLogin: details.account?.login ?? 'unknown',
      accountType: details.account?.type ?? 'User',
      suspendedAt: details.suspended_at ? new Date(details.suspended_at) : null,
    },
  });
}

/**
 * GET /api/github-app/callback — the ONE callback for every GitHub entry
 * point in the app (auth.controller.ts's githubRedirectHandler /
 * githubConnectRedirectHandler, and githubAppInstallRedirectHandler above).
 * Public (no requireAuth is even possible on a plain browser redirect);
 * the signed `state` JWT (see auth.tokens.ts's signGithubFlowState) is what
 * proves both which flow this is (`intent`) and, for 'connect'/'install',
 * which Dreamer user it belongs to — cross-checked against the httpOnly
 * cookie the same way every state param in this app is cross-checked.
 *
 * Because the GitHub App has "Request user authorization during
 * installation" enabled, EVERY redirect back here carries a `code` (proving
 * identity) and MAY carry an installation_id (if this pass also
 * installed/updated the App on an account) — the two are handled
 * independently: identity always resolves first, then
 * linkInstallationIfPresent() runs if there's an installation_id, for
 * whichever userId identity resolution landed on.
 */
export async function githubAppCallbackHandler(req: Request, res: Response) {
  const { code, state, installation_id, setup_action } = req.query as {
    code?: string;
    state?: string;
    installation_id?: string;
    setup_action?: string;
  };
  const cookieState = req.cookies?.[GITHUB_STATE_COOKIE_NAME];

  res.clearCookie(GITHUB_STATE_COOKIE_NAME, { path: GITHUB_CALLBACK_PATH });

  if (setup_action === 'request') {
    // The installing account required org-admin approval — nothing to link
    // yet; GitHub notifies the admin separately. Nothing failed here.
    return res.redirect(`${env.FRONTEND_URL}/dashboard/new?github_app=pending_approval`);
  }

  if (!code || !state || !cookieState || state !== cookieState) {
    return res.redirect(`${env.FRONTEND_URL}/login?error=github_state_mismatch`);
  }

  const flow = verifyGithubFlowState(state);
  if (!flow) {
    return res.redirect(`${env.FRONTEND_URL}/login?error=github_state_mismatch`);
  }

  // 'login': no prior identity — resolve/create the user from the OAuth
  // code itself, same find-or-link-or-create logic "Continue with GitHub"
  // has always used.
  if (flow.intent === 'login') {
    try {
      const githubAccessToken = await exchangeCodeForToken(code);
      const profile = await fetchGithubProfile(githubAccessToken);
      const verifiedEmail = await fetchPrimaryVerifiedGithubEmail(githubAccessToken);

      const { refreshToken, user } = await authService.loginOrRegisterWithGithub({
        profile,
        verifiedEmail,
        githubAccessToken,
        meta: sessionMeta(req),
      });

      setRefreshCookie(res, refreshToken);
      await linkInstallationIfPresent(user.id, githubAccessToken, installation_id);

      // We deliberately do NOT put the access token in this redirect URL —
      // URLs end up in browser history and server access logs. The frontend
      // lands on /auth/callback and immediately calls POST /auth/refresh,
      // which reads the httpOnly cookie we just set and returns a fresh
      // access token straight into memory.
      return res.redirect(`${env.FRONTEND_URL}/auth/callback`);
    } catch (err) {
      logger.error('GitHub login callback failed', { err });
      return res.redirect(`${env.FRONTEND_URL}/login?error=github_auth_failed`);
    }
  }

  // 'connect' and 'install': identity (userId) already known from the
  // signed state — connectGithubAccount() links/refreshes it, then any
  // installation_id gets linked to that same, known user.
  const userId = flow.userId;
  const returnTo = flow.returnTo ?? '/dashboard/account';

  if (!userId) {
    // Should be unreachable (both intents always sign a userId), but a
    // malformed/forged state shouldn't ever fall through silently.
    return res.redirect(`${env.FRONTEND_URL}/login?error=github_state_mismatch`);
  }

  try {
    const githubAccessToken = await exchangeCodeForToken(code);
    const profile = await fetchGithubProfile(githubAccessToken);
    const verifiedEmail = await fetchPrimaryVerifiedGithubEmail(githubAccessToken);

    await authService.connectGithubAccount(userId, { profile, verifiedEmail, githubAccessToken }, sessionMeta(req));
    await linkInstallationIfPresent(userId, githubAccessToken, installation_id);

    return res.redirect(`${env.FRONTEND_URL}${returnTo}?github=connected`);
  } catch (err) {
    // GITHUB_ALREADY_LINKED is an expected, user-facing outcome (someone
    // else already connected that GitHub account) — surface its code
    // specifically so the frontend can show the right message instead of a
    // generic failure.
    const errCode = err instanceof Error && 'code' in err ? (err as { code: string }).code : undefined;
    logger.error('GitHub connect/install callback failed', { err, intent: flow.intent });
    return res.redirect(
      `${env.FRONTEND_URL}${returnTo}?error=${errCode === 'GITHUB_ALREADY_LINKED' ? 'github_already_linked' : 'github_connect_failed'}`
    );
  }
}
