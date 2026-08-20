import rateLimit from 'express-rate-limit';

/** Factory so every route can tune its own window/max independently. */
function createRateLimiter(windowMinutes: number, max: number) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: true, // sends RateLimit-* response headers
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
  });
}

// Tight limits on the most abuse-prone auth endpoints — blunt enough to stop
// naive brute-force / credential-stuffing scripts without needing a WAF.
// RAISED — the previous ceilings were tight enough to be hit by a single
// legitimate user during normal use (a few mistyped passwords, a page
// refreshed a few times), not just by an abuse script. Values below are
// roughly 3x the old ones; still bounded, just less trigger-happy.
export const loginRateLimiter = createRateLimiter(15, 30); // 30 attempts / 15 min / IP
export const registerRateLimiter = createRateLimiter(60, 15); // 15 signups / hour / IP
export const refreshRateLimiter = createRateLimiter(15, 90); // refresh fires often — give it room

//  NEW — reveal returns a real plaintext secret, not just a yes/no. Raised
// from 20 to 60 per 15 minutes per IP — generous enough for someone
// clicking through several vars on the env page in one sitting, tight
// enough to blunt a scripted "reveal everything on this project" sweep run
// against a stolen session.
export const revealEnvVariableRateLimiter = createRateLimiter(15, 60);

// NEW — both of these send an email and both intentionally return an
// identical response whether or not the account exists (see auth.service.ts),
// so rate limiting is the only real defense against someone using them to
// spam an arbitrary inbox. Raised from 3 to 8/hour — still tighter than
// login/register on purpose, just less likely to block a legitimate retry.
export const resendVerificationRateLimiter = createRateLimiter(60, 8); // 8 / hour / IP
export const forgotPasswordRateLimiter = createRateLimiter(60, 8); // 8 / hour / IP