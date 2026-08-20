import { z } from 'zod';

/**
 * The subset of GitHub's push event payload this handler actually reads —
 * deliberately narrow, same reasoning as integrations/github-repo.service.ts's
 * RepoEntry: GitHub's real payload has dozens of fields (commits[],
 * head_commit.author, compare URL, etc.) we never need, and narrowing here
 * means a future payload shape change can't silently break something
 * downstream that was never supposed to depend on it.
 *
 * `installation.id` is present on every delivery for an App-owned webhook
 * (unlike the old per-repo-webhook version of this file, which had no such
 * field to rely on) — that, plus `repository.id`, is the entire lookup key
 * now. See findProjectForDelivery in github-webhook.service.ts.
 */
export const githubPushPayloadSchema = z.object({
  ref: z.string(), // "refs/heads/main"
  before: z.string(),
  after: z.string(), // the commit SHA to build — see deployment.service.ts's createWebhookDeployment
  deleted: z.boolean().default(false), // true = this "push" was actually a branch delete
  repository: z.object({
    id: z.number(),
    full_name: z.string(),
  }),
  installation: z.object({ id: z.number() }),
  head_commit: z
    .object({
      id: z.string(),
      message: z.string().optional(),
      author: z.object({ name: z.string().optional(), username: z.string().optional() }).optional(),
    })
    .nullable()
    .optional(), // null on a branch-delete push
  pusher: z.object({ name: z.string().optional() }).optional(),
});

export type GithubPushPayload = z.infer<typeof githubPushPayloadSchema>;

/**
 * GitHub's `installation` event — sent when a user installs, uninstalls,
 * suspends, or unsuspends the App. Only `deleted`/`suspend`/`unsuspend`
 * are handled (see github-webhook.service.ts's handleInstallationEvent);
 * `created` is intentionally NOT handled here, since that case is already
 * covered synchronously by the install callback
 * (integrations/github-app-install.controller.ts) the moment GitHub
 * redirects the browser back — this event is the async backstop for
 * everything that can happen to an installation AFTER that point, from
 * GitHub's own settings UI rather than through Dreamer.
 */
export const githubInstallationPayloadSchema = z.object({
  action: z.enum(['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted']),
  installation: z.object({
    id: z.number(),
    account: z.object({ login: z.string(), type: z.string() }).optional(),
  }),
});

export type GithubInstallationPayload = z.infer<typeof githubInstallationPayloadSchema>;

/**
 * GitHub's `installation_repositories` event — sent when repos are
 * added/removed from an EXISTING installation (e.g. the user goes back to
 * GitHub's settings and grants/revokes access to specific repos, without
 * uninstalling the whole App). Only `removed` matters here: any Project
 * pointing at one of those repositoryIds can no longer be built or
 * webhook-triggered through this installation.
 */
export const githubInstallationRepositoriesPayloadSchema = z.object({
  action: z.enum(['added', 'removed']),
  installation: z.object({ id: z.number() }),
  repositories_removed: z.array(z.object({ id: z.number(), full_name: z.string() })).optional(),
});

export type GithubInstallationRepositoriesPayload = z.infer<typeof githubInstallationRepositoriesPayloadSchema>;

/** GitHub's ping payload, sent once immediately after the App's webhook is configured — no repository push info to act on. */
export const githubPingPayloadSchema = z.object({
  zen: z.string().optional(),
  hook_id: z.number().optional(),
});
