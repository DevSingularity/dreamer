import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { BadRequestError, NotFoundError } from '../lib/errors';
import { decryptFromStorage } from '../lib/crypto';
import { getInstallationAccessToken } from '../lib/github-app';
import { resolveDetectedBuildConfig } from './build-config.service';
import { listPublicPresets } from './framework-presets';
import type { DetectBuildConfigInput } from './build-config.types';

/**
 * Same installationId-first, OAuth-token-fallback pattern
 * integrations/github-repo.controller.ts uses for repo-contents/branches —
 * duplicated rather than imported from there on purpose, since this one is
 * unconditional (the wizard always needs to read repo contents to detect
 * anything, public or private) where that file's callers are gated behind
 * an explicit installationId-or-not branch per request.
 *
 * GitHub App migration note: this used to unconditionally require
 * User.githubToken — a leftover from before repo access moved to the App,
 * which broke detection entirely for a repo picked via public search (no
 * OAuth connection required for that path at all) and for any private repo
 * behind an installation (the OAuth token has no repo scope anymore). Now
 * mints an installation token when one is given and owned by the caller,
 * and only falls back to the (scope-less, public-data-only) OAuth token
 * when there isn't one.
 */
async function resolveDetectionAccessToken(userId: string, installationId?: number): Promise<string | undefined> {
  if (installationId) {
    const installation = await prisma.githubInstallation.findFirst({ where: { installationId, userId } });
    if (!installation) {
      throw new NotFoundError('GitHub installation not found', 'GITHUB_INSTALLATION_NOT_FOUND');
    }
    if (installation.suspendedAt) {
      throw new BadRequestError(
        'This GitHub App installation is suspended — reactivate it from GitHub before importing repositories',
        'GITHUB_INSTALLATION_SUSPENDED'
      );
    }
    return getInstallationAccessToken(installationId);
  }

  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { githubToken: true } });
  // No installation given AND no OAuth token — not an error. A repo picked
  // via public search (integrations/github-repo.controller.ts's
  // searchPublicReposHandler) needs neither: detection just runs
  // unauthenticated, same as browsing that repo's contents/branches did in
  // the wizard's previous step. Only actually private repo detection would
  // fail downstream from this, and it fails with a clear GitHub 404, not a
  // confusing upfront "connect your account" for a user who never needed to.
  return owner?.githubToken ? decryptFromStorage(owner.githubToken) : undefined;
}

/** POST /api/build-config/detect — called by the wizard right after the user confirms a root directory. */
export async function detectBuildConfigHandler(req: Request, res: Response) {
  const { installationId, repoFullName, branch, rootDirectory } = req.body as DetectBuildConfigInput;

  const accessToken = await resolveDetectionAccessToken(req.user!.id, installationId);
  const detected = await resolveDetectedBuildConfig(accessToken, repoFullName, branch, rootDirectory);

  res.status(200).json({ detected });
}

/**
 * GET /api/build-config/presets — the full preset table, with defaults.
 * Called once when the wizard mounts (not per-keystroke) to populate the
 * "Application Preset" dropdown's options. When the user manually picks a
 * different preset than what was auto-detected, the wizard re-fills the
 * build/install/output fields from THIS list rather than re-calling
 * /detect — switching presets is a local, instant UI action, not something
 * that should wait on a fresh GitHub API round trip.
 */
export async function listPresetsHandler(_req: Request, res: Response) {
  res.status(200).json({ presets: listPublicPresets() });
}
