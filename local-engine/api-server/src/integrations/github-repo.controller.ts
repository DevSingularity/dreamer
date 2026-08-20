import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { BadRequestError, NotFoundError } from '../lib/errors';
import { decryptFromStorage } from '../lib/crypto';
import { getInstallationAccessToken, listInstallationRepos } from '../lib/github-app';
import { listBranches, listRepoDirectory, searchPublicRepos } from './github-repo.service';
import type {
  ListBranchesQuery,
  ListRepoDirectoryQuery,
  ListReposQuery,
  SearchPublicReposQuery,
} from './github-repo.types';

/**
 * Every handler that touches ONE installation's repos needs an installation
 * ACCESS TOKEN, not just an installation ID — this is the shared step:
 * confirm the installation actually belongs to the caller (never trust a
 * client-supplied installationId alone; see project.service.ts's
 * createProject for the same check on the write path), then mint a token
 * for it.
 */
async function resolveOwnedInstallationToken(userId: string, installationId: number): Promise<string> {
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

/**
 * Best-effort — used only for public-repo browsing (search, and browsing a
 * repo with no installation behind it), where a token is a rate-limit
 * upgrade, not a requirement. Returns undefined rather than throwing when
 * the caller has never connected GitHub at all — that's meant to work too
 * (see github-repo.service.ts's searchPublicRepos doc comment).
 */
async function resolveOptionalOAuthToken(userId: string): Promise<string | undefined> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { githubToken: true } });
  return user?.githubToken ? decryptFromStorage(user.githubToken) : undefined;
}

/**
 * GET /api/github/installations — every GitHub account/org the caller has
 * installed the Dreamer GitHub App on. The wizard shows this as a picker
 * ABOVE the repo list whenever the user has more than one (e.g. their
 * personal account plus an org) — see integrations/github-app-install.controller.ts
 * for how a row here gets created in the first place.
 */
export async function listInstallationsHandler(req: Request, res: Response) {
  const installations = await prisma.githubInstallation.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: 'asc' },
    select: { installationId: true, accountLogin: true, accountType: true, suspendedAt: true },
  });

  res.status(200).json({
    installations: installations.map((i: { installationId: number; accountLogin: string; accountType: string; suspendedAt: Date | null }) => ({
      installationId: i.installationId,
      accountLogin: i.accountLogin,
      accountType: i.accountType,
      suspended: i.suspendedAt !== null,
    })),
  });
}

/** GET /api/github/repos?installationId=... — the wizard's "Import Git Repository" list (step 1), scoped to one installation. Auto-deploy works for anything picked from here. */
export async function listReposHandler(req: Request, res: Response) {
  const { installationId } = req.query as unknown as ListReposQuery;

  // Ownership check first — listInstallationRepos would happily mint a
  // token and list repos for an installationId the caller doesn't own if
  // this weren't here (installation IDs are globally sequential, easily
  // guessable integers, not secrets).
  await resolveOwnedInstallationToken(req.user!.id, installationId);
  const repos = await listInstallationRepos(installationId);

  res.status(200).json({
    repos: repos.map((repo) => ({
      repositoryId: repo.id,
      installationId,
      fullName: repo.full_name,
      name: repo.full_name.split('/').slice(1).join('/'),
      defaultBranch: repo.default_branch,
      isPrivate: repo.private,
      updatedAt: repo.updated_at,
    })),
  });
}

/**
 * GET /api/github/public-repos?query=... — search ANY public GitHub repo by
 * name, not just ones the caller's App installation can see. Deliberately
 * NOT gated behind having an installation (or even a connected GitHub
 * account) at all — see github-repo.service.ts's searchPublicRepos doc
 * comment for why a public repo doesn't need one to be read.
 *
 * `installationId: null` in every result — auto-deploy won't work for a
 * project created from one of these until the App is separately installed
 * on it, which the frontend surfaces as "Not connected" rather than
 * pretending it's already wired up.
 */
export async function searchPublicReposHandler(req: Request, res: Response) {
  const { query } = req.query as unknown as SearchPublicReposQuery;

  const accessToken = await resolveOptionalOAuthToken(req.user!.id);
  const repos = await searchPublicRepos(accessToken, query);

  res.status(200).json({
    repos: repos.map((repo) => ({ ...repo, installationId: null })),
  });
}

/** GET /api/github/repo-contents - lazily lists one directory level at a time for the root-directory picker. installationId is optional — omitted for a repo found via public search (see searchPublicReposHandler). */
export async function listRepoDirectoryHandler(req: Request, res: Response) {
  const { installationId, repoFullName, branch, path } = req.query as unknown as ListRepoDirectoryQuery;

  const accessToken = installationId
    ? await resolveOwnedInstallationToken(req.user!.id, installationId)
    : await resolveOptionalOAuthToken(req.user!.id);
  const entries = await listRepoDirectory(accessToken, repoFullName, path, branch);

  res.status(200).json({ entries });
}

/**
 * GET /api/github/branches - shared by the wizard's branch picker and the
 * project-settings "Production Branch" dropdown. installationId is optional
 * for the same reason as listRepoDirectoryHandler above.
 */
export async function listBranchesHandler(req: Request, res: Response) {
  const { installationId, repoFullName, defaultBranch } = req.query as unknown as ListBranchesQuery;

  const accessToken = installationId
    ? await resolveOwnedInstallationToken(req.user!.id, installationId)
    : await resolveOptionalOAuthToken(req.user!.id);
  const branches = await listBranches(accessToken, repoFullName, defaultBranch);

  res.status(200).json({ branches });
}
