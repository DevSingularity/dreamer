import type { Request, Response } from 'express';
import { logger } from '../lib/logger';
import {
  verifyGithubSignature,
  findProjectsForPush,
  handlePushEvent,
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
} from './github-webhook.service';
import {
  githubPushPayloadSchema,
  githubInstallationPayloadSchema,
  githubInstallationRepositoriesPayloadSchema,
} from './github-webhook.types';

/**
 * POST /api/webhooks/github — the ONE endpoint the GitHub App's webhook
 * points at, covering every installation and every repo it can see (see
 * docs/deployments/github-app-migration.md). Mounted PUBLICLY in app.ts (no
 * requireAuth: GitHub, not a logged-in user, calls this) — signature
 * verification is what stands in for auth here, same role a JWT plays on
 * every other route.
 *
 * Always returns fast and always returns 2xx once a delivery is verified,
 * even for events this handler chooses not to act on — a webhook endpoint
 * that 4xx/5xxs a well-formed, correctly-signed delivery just because it
 * decided not to do anything with it trains GitHub to mark the hook
 * unhealthy and eventually stop delivering.
 */
export async function githubWebhookHandler(req: Request, res: Response) {
  const rawBody = req.rawBody;
  if (!rawBody) {
    // Only reachable if app.ts's express.json() verify hook was ever
    // removed/bypassed for this route — signature verification is
    // impossible without the exact bytes GitHub signed.
    logger.error('GitHub webhook received with no raw body captured');
    return res.status(500).json({ error: 'Internal server error', code: 'WEBHOOK_RAW_BODY_MISSING' });
  }

  const signature = req.header('X-Hub-Signature-256');
  if (!verifyGithubSignature(rawBody, signature)) {
    // Deliberately vague — same reasoning as any failed-auth response:
    // don't distinguish "no secret configured" from "bad signature" from
    // "tampered body" for an unauthenticated caller.
    logger.warn('GitHub webhook delivery failed signature verification');
    return res.status(401).json({ error: 'Signature verification failed', code: 'WEBHOOK_UNAUTHORIZED' });
  }

  const eventType = req.header('X-GitHub-Event');
  const deliveryId = req.header('X-GitHub-Delivery');

  switch (eventType) {
    case 'ping':
      return res.status(200).json({ pong: true });

    case 'push':
      return handlePush(req, res, deliveryId ?? undefined);

    case 'installation':
      return handleInstallation(req, res);

    case 'installation_repositories':
      return handleInstallationRepositories(req, res);

    default:
      // The App is only ever subscribed to push/installation/installation_repositories
      // (see docs/deployments/github-app-migration.md's setup steps) — this
      // is defensive, not expected.
      return res.status(200).json({ received: true, ignored: true, reason: `Unhandled event type "${eventType}"` });
  }
}

async function handlePush(req: Request, res: Response, deliveryId: string | undefined) {
  const parsed = githubPushPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn('GitHub push payload failed validation', { deliveryId });
    return res.status(400).json({ error: 'Malformed push payload', code: 'WEBHOOK_BAD_PAYLOAD' });
  }

  const { installation, repository } = parsed.data;
  const projects = await findProjectsForPush(installation.id, repository.id);

  if (projects.length === 0) {
    // A valid, correctly-signed delivery for a repo Dreamer just doesn't
    // have a Project for (e.g. the App is installed on more repos than the
    // user has actually imported) — not an error, nothing to do.
    return res.status(200).json({ received: true, ignored: true, reason: 'No project linked to this repository' });
  }

  // Usually exactly one match; more than one only when the same repo has
  // been imported into multiple projects (see findProjectsForPush) — every
  // matching project gets evaluated independently rather than only the
  // first one found.
  const outcomes = await Promise.all(
    projects.map((project) => handlePushEvent(project, parsed.data, { githubDeliveryId: deliveryId }))
  );

  return res.status(200).json({ received: true, outcomes });
}

async function handleInstallation(req: Request, res: Response) {
  const parsed = githubInstallationPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Malformed installation payload', code: 'WEBHOOK_BAD_PAYLOAD' });
  }

  await handleInstallationEvent(parsed.data);
  return res.status(200).json({ received: true });
}

async function handleInstallationRepositories(req: Request, res: Response) {
  const parsed = githubInstallationRepositoriesPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Malformed installation_repositories payload', code: 'WEBHOOK_BAD_PAYLOAD' });
  }

  await handleInstallationRepositoriesEvent(parsed.data);
  return res.status(200).json({ received: true });
}
