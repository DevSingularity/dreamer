import { Router } from 'express';
import { githubAppInstallRedirectHandler, githubAppCallbackHandler } from './github-app-install.controller';

/**
 * Both routes are public (no requireAuth) — see
 * github-app-install.controller.ts's doc comments for why: the redirect
 * handler is a plain browser navigation with no Authorization header to
 * check (identity comes from the refresh-token cookie instead), and the
 * callback is GitHub redirecting the browser back, which can never carry
 * one either.
 *
 * /callback is now the SINGLE shared callback for every GitHub entry point
 * in the app — auth.controller.ts's /api/auth/github and
 * /api/auth/github/connect both redirect here too, not just /install.
 */
export const githubAppInstallRouter = Router();

githubAppInstallRouter.get('/install', githubAppInstallRedirectHandler);
githubAppInstallRouter.get('/callback', githubAppCallbackHandler);
