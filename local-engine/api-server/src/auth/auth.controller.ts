import type { Request, Response } from 'express';
import { env } from '../lib/env';
import { UnauthorizedError } from '../lib/errors';
import * as authService from './auth.service';
import { buildGithubAuthorizeUrl } from './github.service';
import { signGithubFlowState, GITHUB_STATE_COOKIE_NAME, GITHUB_CALLBACK_PATH, type SessionMeta } from './auth.tokens';

// Exported: integrations/github-app-install.controller.ts sets/reads this
// exact cookie too (install-only login + the shared callback's login
// branch) and must use identical attributes — previously duplicated there,
// which let the two copies' secure/sameSite logic silently drift apart.
export const REFRESH_COOKIE_NAME = 'refreshToken';
// Path is '/api', not '/api/auth': the cookie must also reach
// /api/github-app/install and /api/github-app/callback (see
// integrations/github-app-install.controller.ts), which read this same
// cookie to resolve identity outside the /api/auth route tree.
export const REFRESH_COOKIE_PATH = '/api';


function sessionMeta(req: Request): SessionMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

// Derive cross-site-ness from FRONTEND_URL vs COOKIE_DOMAIN rather than
// NODE_ENV, so the cookie settings are correct even if NODE_ENV isn't set
// to 'production' on the host.
//
// Three cases:
//  1. Localhost dev (no COOKIE_DOMAIN, frontend on localhost) — SameSite=Lax,
//     Secure=false, no Domain attribute. Frontend and API share a site.
//  2. COOKIE_DOMAIN set (frontend and API on subdomains of the same
//     registrable domain, e.g. deploy.yourdomain.com + api.yourdomain.com) —
//     SameSite=Lax, Secure=true, Domain=.yourdomain.com. This is the
//     recommended production setup: same-site, so it's immune to every
//     browser's third-party-cookie blocking (see env.ts's COOKIE_DOMAIN
//     comment for why that matters).
//  3. Neither (genuinely cross-site domains, e.g. a Render default
//     ...onrender.com URL behind a different custom frontend domain) —
//     SameSite=None, Secure=true, no Domain attribute. Spec-compliant, but
//     the resulting cookie IS a third-party cookie from the browser's
//     point of view and can be silently dropped by Safari/Firefox by
//     default and by a growing share of Chrome users — this case is a
//     fallback, not a recommendation. Set COOKIE_DOMAIN and move the API
//     to a same-registrable-domain subdomain instead of relying on this.
function isLocalDev(): boolean {
  const hostname = new URL(env.FRONTEND_URL).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

const COOKIE_DOMAIN_ATTR = env.COOKIE_DOMAIN;
const COOKIE_SAME_SITE = () => (isLocalDev() || COOKIE_DOMAIN_ATTR ? 'lax' as const : 'none' as const);
const COOKIE_SECURE = () => !isLocalDev();

// Shared by every cookie this app sets (refresh token + both GitHub state
// cookies) so they can't drift apart the way secure/sameSite previously did
// across three separate call sites.
export function crossSiteCookieOptions() {
  return {
    secure: COOKIE_SECURE(),
    sameSite: COOKIE_SAME_SITE(),
    ...(COOKIE_DOMAIN_ATTR ? { domain: COOKIE_DOMAIN_ATTR } : {}),
  };
}

// The two GitHub state cookies (below, and in
// integrations/github-app-install.controller.ts) are set and read on this
// SAME api-server host the whole time — GitHub's redirect back is a
// top-level navigation straight to our callback, never touching the
// frontend's domain — so they don't need crossSiteCookieOptions()'s
// SameSite=None/Domain handling, just a secure flag that's actually
// correct off NODE_ENV drift. 'lax' is intentional, not a placeholder: see
// the comment at each call site.
export function stateCookieSecure(): boolean {
  return COOKIE_SECURE();
}

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    ...crossSiteCookieOptions(),
    path: REFRESH_COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    path: REFRESH_COOKIE_PATH,
    ...crossSiteCookieOptions(),
  });
}

// Email + password

export async function registerHandler(req: Request, res: Response) {
  // No accessToken/refreshCookie anymore — the account exists but can't log
  // in until the verification email is clicked. See auth.service.ts.
  const { user } = await authService.register(req.body, sessionMeta(req));
  res.status(201).json({ user });
}

export async function loginHandler(req: Request, res: Response) {
  const { accessToken, refreshToken, user } = await authService.login(req.body, sessionMeta(req));
  setRefreshCookie(res, refreshToken);
  res.status(200).json({ accessToken, user });
}

export async function refreshHandler(req: Request, res: Response) {
  const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!rawToken) throw new UnauthorizedError('No refresh token provided', 'NO_REFRESH_TOKEN');

  const { accessToken, refreshToken, user } = await authService.refresh(rawToken, sessionMeta(req));
  setRefreshCookie(res, refreshToken);
  res.status(200).json({ accessToken, user });
}

export async function logoutHandler(req: Request, res: Response) {
  const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
  await authService.logout(rawToken);
  clearRefreshCookie(res);
  res.status(204).send();
}

export async function logoutAllHandler(req: Request, res: Response) {
  await authService.logoutAll(req.user!.id, sessionMeta(req));
  clearRefreshCookie(res);
  res.status(204).send();
}

export async function meHandler(req: Request, res: Response) {
  const user = await authService.getMe(req.user!.id);
  res.status(200).json({ user });
}

// Sessions & password management

function extractSessionIdFromRefreshCookie(req: Request): string | undefined {
  const raw = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!raw) return undefined;
  const dotIndex = raw.indexOf('.');
  return dotIndex > 0 ? raw.slice(0, dotIndex) : undefined;
}

export async function listSessionsHandler(req: Request, res: Response) {
  const currentSessionId = extractSessionIdFromRefreshCookie(req);
  const sessions = await authService.listSessions(req.user!.id, currentSessionId);
  res.status(200).json({ sessions });
}

export async function revokeSessionHandler(req: Request, res: Response) {
  const sessionId = req.params.sessionId as string;
  await authService.revokeSessionByIdForUser(req.user!.id, sessionId, sessionMeta(req));
  res.status(204).send();
}

export async function changePasswordHandler(req: Request, res: Response) {
  await authService.changePassword(req.user!.id, req.body, sessionMeta(req));
  res.status(204).send();
}

// Email verification / password reset

export async function verifyEmailHandler(req: Request, res: Response) {
  await authService.verifyEmail(req.body, sessionMeta(req));
  res.status(204).send();
}

// Always the same 204, whether or not the email exists / already has a
// password / is already verified — see resendVerification()'s comment.
export async function resendVerificationHandler(req: Request, res: Response) {
  await authService.resendVerification(req.body, sessionMeta(req));
  res.status(204).send();
}

// Always the same 204 — see requestPasswordReset()'s comment.
export async function forgotPasswordHandler(req: Request, res: Response) {
  await authService.requestPasswordReset(req.body, sessionMeta(req));
  res.status(204).send();
}

export async function resetPasswordHandler(req: Request, res: Response) {
  await authService.resetPassword(req.body, sessionMeta(req));
  res.status(204).send();
}

// GitHub (single App: login/signup, account-linking, and repo install all
// go through it now — see docs/deployments/github-app-unified-auth.md). The
// callback for ALL THREE lives in integrations/github-app-install.controller.ts's
// githubAppCallbackHandler, since it also has to handle the installation
// side; these two handlers only ever mint the state + redirect/return the
// authorize URL.

// Only these two relative paths are ever redirected to after a connect —
// resolved server-side from a short code, never taken as a raw path from
// the query string, so this can't be turned into an open redirect.
export const GITHUB_CONNECT_RETURN_TARGETS: Record<string, string> = {
  account: '/dashboard/account',
  project: '/dashboard/new',
};
export const DEFAULT_GITHUB_CONNECT_RETURN = GITHUB_CONNECT_RETURN_TARGETS.account;

/** GET /api/auth/github — redirects the browser to the GitHub App's install+authorize screen. Covers both login and signup — see auth.service.ts's loginOrRegisterWithGithub. */
export function githubRedirectHandler(req: Request, res: Response) {
  const state = signGithubFlowState({ intent: 'login' });

  // Short-lived, httpOnly. 'lax' (not 'strict') because GitHub's redirect
  // back to our callback is a cross-site TOP-LEVEL navigation — a 'strict'
  // cookie would not be sent on that request, breaking the CSRF check below.
  res.cookie(GITHUB_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: stateCookieSecure(),
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: GITHUB_CALLBACK_PATH,
  });

  res.redirect(buildGithubAuthorizeUrl(state));
}

/**
 * GET /api/auth/github/connect — same GitHub App dance as
 * githubRedirectHandler, but for an already-logged-in user linking GitHub
 * to their existing email/password account, from Settings or the New
 * Project wizard.
 *
 * Unlike githubRedirectHandler, this one returns JSON instead of
 * redirecting: it's behind requireAuth, which only ever sees the access
 * token on a request carrying an `Authorization: Bearer` header — a plain
 * `<a href>` navigation to GitHub can't attach one. So the frontend calls
 * this via apiFetch (which does attach it) to get the authorize URL, then
 * does the actual top-level navigation itself. The `state` this mints
 * carries intent: 'connect' plus the caller's userId (see auth.tokens.ts),
 * which is how the shared callback tells this flow apart from a fresh
 * login/register.
 */
export function githubConnectRedirectHandler(req: Request, res: Response) {
  const requestedReturnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined;
  const returnTo = (requestedReturnTo && GITHUB_CONNECT_RETURN_TARGETS[requestedReturnTo]) || DEFAULT_GITHUB_CONNECT_RETURN;

  const state = signGithubFlowState({ intent: 'connect', userId: req.user!.id, returnTo });

  // Set via a fetch() response (credentials: 'include' on the frontend's
  // apiFetch call) rather than a redirect — still a normal Set-Cookie the
  // browser stores, still read back by the shared callback after GitHub's
  // own redirect lands there directly (a real top-level navigation).
  res.cookie(GITHUB_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: stateCookieSecure(),
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: GITHUB_CALLBACK_PATH,
  });

  res.status(200).json({ url: buildGithubAuthorizeUrl(state) });
}