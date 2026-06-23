import type { DeploymentLog, DeploymentStatus } from '../generated/prisma/client';

/**
 * Everything published on Redis channel `deployment:{deploymentId}`.
 * build-engine (apps/build-engine/script.js) is the only producer.
 * Two message shapes share one channel, disambiguated by `type` — keeping
 * logs and status on the same channel (rather than two) means one
 * subscriber, one ordering guarantee, one place that can fail.
 */
export type DeploymentEvent = DeploymentLogEvent | DeploymentStatusEvent;

export interface DeploymentLogEvent {
  type: 'log';
  level: DeploymentLog['level'];
  message: string;
  source?: string;
}

export interface DeploymentStatusEvent {
  type: 'status';
  status: DeploymentStatus;
  reason?: string;
  url?: string;
  errorCode?: string;
  errorMessage?: string;
  errorStep?: string;
}

export function isDeploymentEvent(value: unknown): value is DeploymentEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type: unknown }).type;
  return type === 'log' || type === 'status';
}
