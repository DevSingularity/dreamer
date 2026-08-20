import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { env } from '../lib/env';
import { invalidateInstallationTokenCache } from '../lib/github-app';
import { createWebhookDeployment, hasActiveDeployment } from '../deployments/deployment.service';
import type {
  GithubInstallationPayload,
  GithubInstallationRepositoriesPayload,
  GithubPushPayload,
} from './github-webhook.types';
import type { Project } from '../generated/prisma/client';

const BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * GitHub signs every delivery's exact request body as
 * `X-Hub-Signature-256: sha256=<hex hmac>`, using ONE secret configured on
 * the App itself (GITHUB_APP_WEBHOOK_SECRET) — covering every installation,
 * every repo, every event type. This is the one big simplification the
 * GitHub App migration brought to this file: the old per-repo-webhook
 * version had to decrypt a different secret per Project before it could
 * even find out which Project a delivery was for; this version verifies
 * against a single env var FIRST, and only looks up a Project afterward.
 *
 * timingSafeEqual over the raw digest bytes, not the two hex strings —
 * comparing hex strings char-by-char with a naive === reopens the same
 * timing side-channel this exists to prevent.
 */
export function verifyGithubSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', env.GITHUB_APP_WEBHOOK_SECRET).update(rawBody).digest();
  const provided = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');

  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * `installation.id` + `repository.id` together are the intended lookup
 * key, but nothing in the schema enforces that pair as unique on Project —
 * two different users (or two projects for the same user) can both import
 * the same repo through the same installation, and both rows will match
 * here. Returning every match (rather than findFirst, which would pick
 * whichever row Postgres happens to return first and silently leave the
 * other never auto-deploying) means a shared repo just deploys every
 * project that imported it, which is the same "every match reacts"
 * behavior GitHub's own delivery already assumes for webhooks with
 * multiple subscribers.
 */
export async function findProjectsForPush(installationId: number, repositoryId: number): Promise<Project[]> {
  return prisma.project.findMany({ where: { installationId, repositoryId, deletedAt: null } });
}

export interface WebhookDeliveryOutcome {
  deploymentTriggered: boolean;
  deploymentId?: string;
  skipReason?: string;
}

/**
 * The actual "should this push redeploy?" decision + side effects, once
 * signature verification has already passed and a matching project has
 * been found. Scope is deliberately narrow per this feature's brief:
 * production-branch pushes only — no preview deployments, no PR handling.
 */
export async function handlePushEvent(
  project: Project,
  payload: GithubPushPayload,
  meta: { githubDeliveryId?: string }
): Promise<WebhookDeliveryOutcome> {
  const branch = payload.ref.startsWith(BRANCH_REF_PREFIX) ? payload.ref.slice(BRANCH_REF_PREFIX.length) : payload.ref;

  const outcome = await decideOutcome(project, payload, branch);

  await prisma.webhookDelivery.create({
    data: {
      projectId: project.id,
      githubDeliveryId: meta.githubDeliveryId,
      event: 'PUSH',
      branch,
      commitHash: payload.after,
      commitMessage: payload.head_commit?.message,
      deploymentTriggered: outcome.deploymentTriggered,
      deploymentId: outcome.deploymentId,
      skipReason: outcome.skipReason,
      rawPayload: payload,
    },
  });

  return outcome;
}

async function decideOutcome(project: Project, payload: GithubPushPayload, branch: string): Promise<WebhookDeliveryOutcome> {
  if (payload.deleted) {
    return { deploymentTriggered: false, skipReason: 'Push was a branch deletion' };
  }

  if (!project.autoDeployEnabled) {
    return { deploymentTriggered: false, skipReason: 'Auto-deploy is disabled for this project' };
  }

  if (branch !== project.defaultBranch) {
    // Deliberately not a "preview deployment" path — out of scope for this
    // feature. A push to any branch other than the configured production
    // branch is logged (so "why didn't my push deploy" is answerable from
    // the WebhookDelivery table) and otherwise ignored.
    return {
      deploymentTriggered: false,
      skipReason: `Branch "${branch}" is not the production branch ("${project.defaultBranch}")`,
    };
  }

  if (await hasActiveDeployment(project.id)) {
    return { deploymentTriggered: false, skipReason: 'A deployment for this project is already in progress' };
  }

  try {
    const deployment = await createWebhookDeployment(
      project.id,
      project.userId,
      { branch, commitHash: payload.after },
      { userAgent: 'GitHub-Webhook' }
    );
    return { deploymentTriggered: true, deploymentId: deployment.id };
  } catch (err) {
    // Never let a failure to ENQUEUE the build make this handler throw —
    // GitHub interprets a non-2xx as "redeliver this," and retried
    // redeliveries of the same push wouldn't fix an underlying problem
    // like a revoked installation. Log it, record it on the delivery row,
    // and let the user retry manually (redeploy button) instead.
    logger.error('Webhook-triggered deployment failed to enqueue', { projectId: project.id, err });
    return {
      deploymentTriggered: false,
      skipReason: `Failed to start deployment: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/**
 * Handles `suspend`/`unsuspend`/`deleted` — the async backstop for
 * anything that happens to an installation from GitHub's OWN settings UI,
 * outside Dreamer's install flow (which already handles `created`
 * synchronously — see integrations/github-app-install.controller.ts).
 * `new_permissions_accepted` is intentionally a no-op here — it doesn't
 * change which repos/projects this installation covers.
 */
export async function handleInstallationEvent(payload: GithubInstallationPayload): Promise<void> {
  const { installation, action } = payload;

  if (action === 'deleted') {
    // Cascades to null out installationId on any Project that referenced
    // it (see schema.prisma's Project.installation onDelete: SetNull) —
    // those projects simply stop being auto-deployable until someone
    // relinks them to a fresh installation from Settings.
    await prisma.githubInstallation.deleteMany({ where: { installationId: installation.id } });
    invalidateInstallationTokenCache(installation.id);
    return;
  }

  if (action === 'suspend' || action === 'unsuspend') {
    await prisma.githubInstallation.updateMany({
      where: { installationId: installation.id },
      data: { suspendedAt: action === 'suspend' ? new Date() : null },
    });
    invalidateInstallationTokenCache(installation.id);
  }
}

/**
 * Handles `removed` — repos taken out of an installation without the whole
 * App being uninstalled. Doesn't mutate affected Projects (there's no
 * "installation lost this repo" flag on the schema, and adding one purely
 * to react to a rare event is more schema than the case warrants) — just
 * logs which projects are affected so it's debuggable. In practice this is
 * self-enforcing anyway: GitHub simply stops delivering push events for a
 * repo the App no longer has access to, so createWebhookDeployment for it
 * never gets called again regardless.
 */
export async function handleInstallationRepositoriesEvent(payload: GithubInstallationRepositoriesPayload): Promise<void> {
  if (payload.action !== 'removed' || !payload.repositories_removed?.length) return;

  const repositoryIds = payload.repositories_removed.map((r) => r.id);
  const affected = await prisma.project.findMany({
    where: { installationId: payload.installation.id, repositoryId: { in: repositoryIds }, deletedAt: null },
    select: { id: true, repoFullName: true },
  });

  if (affected.length > 0) {
    logger.warn('GitHub App lost access to repositories backing existing projects', {
      installationId: payload.installation.id,
      affected,
    });
  }
}
