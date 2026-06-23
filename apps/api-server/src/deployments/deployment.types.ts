import { z } from 'zod';
import type { Deployment, DeploymentLog, DeploymentStateTransition } from '../generated/prisma/client';

export const createDeploymentSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  body: z.object({
    // Defaults to the project's own defaultBranch — resolved in the service
    // layer, since the schema has no access to the project row to default
    // against.
    branch: z.string().min(1).max(255).trim().optional(),
  }),
});

export const listDeploymentsQuerySchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
});

export const deploymentIdParamSchema = z.object({
  params: z.object({ deploymentId: z.uuid() }),
});

export const listDeploymentLogsSchema = z.object({
  params: z.object({ deploymentId: z.uuid() }),
  query: z.object({
    // Cursor by sequence number, not offset/limit — logs are an append-only,
    // strictly ordered stream; "give me everything after sequence N" stays
    // correct even while a build is actively writing new lines underneath
    // you. An offset would shift mid-poll.
    after: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  }),
});

export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>['body'];

/** Shape returned to the client — never the AWS ARNs, the S3 prefix, or anything else AWS-shaped. */
export interface PublicDeployment {
  id: string;
  projectId: string;
  slug: string;
  status: Deployment['status'];
  type: Deployment['type'];
  framework: Deployment['framework'];
  branch: string;
  commitHash: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  url: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  errorStep: string | null;
  buildDurationMs: number | null;
  triggeredBy: string;
  queuedAt: Date;
  buildStartedAt: Date | null;
  buildFinishedAt: Date | null;
  deployedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
}

export interface PublicStateTransition {
  id: string;
  fromStatus: DeploymentStateTransition['fromStatus'];
  toStatus: DeploymentStateTransition['toStatus'];
  reason: string | null;
  createdAt: Date;
}

/**
 * DeploymentLog.id is a Postgres BIGSERIAL → Prisma types it as a JS
 * `bigint`. `JSON.stringify({ id: 5n })` throws — `TypeError: Do not know how
 * to serialize a BigInt`. Every log line that crosses the HTTP or socket
 * boundary goes through this DTO (id pre-converted to a string), never the
 * raw Prisma row. This is the single most common production bug with
 * BigInt primary keys in a Node API — worth knowing by name, not just
 * working around once.
 */
export interface PublicLogLine {
  id: string;
  level: DeploymentLog['level'];
  message: string;
  sequence: number;
  source: string | null;
  timestamp: Date;
}

export interface DeploymentDetail extends PublicDeployment {
  stateTransitions: PublicStateTransition[];
}
