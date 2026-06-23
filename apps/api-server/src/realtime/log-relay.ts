import Redis from 'ioredis';
import type { Server } from 'socket.io';
import { appendLogLine, transitionDeploymentStatus } from '../deployments/deployment.service';
import { env } from '../lib/env';
import { isDeploymentEvent } from './realtime.types';
import { roomFor } from './socket.server';

const CHANNEL_PATTERN = 'deployment:*';

/**
 * Bridges build-engine's Redis pub/sub messages to (a) Postgres, so logs and
 * status survive a page reload or a finished build, and (b) every connected
 * dashboard client watching that deployment, via Socket.IO. This is the
 * ONLY thing in api-server that calls
 * deploymentService.{appendLogLine,transitionDeploymentStatus} on behalf of
 * something outside an HTTP request — keeping that in one file is what
 * makes "where do status updates actually come from?" a one-file answer.
 */
export async function startLogRelay(io: Server): Promise<void> {
  // A DEDICATED connection. Once an ioredis client calls (p)subscribe it can
  // no longer run ordinary commands (appendLogLine's INCR, for instance) —
  // this can never be the same client lib/redis.ts hands out for everyday
  // use.
  const subscriber = new Redis(env.REDIS_URL);
  await subscriber.psubscribe(CHANNEL_PATTERN);

  subscriber.on('pmessage', async (_pattern: string, channel: string, raw: string) => {
    const deploymentId = channel.slice('deployment:'.length);

    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      console.error('[LOG_RELAY] Non-JSON message on', channel, raw);
      return;
    }

    if (!isDeploymentEvent(event)) {
      console.error('[LOG_RELAY] Unrecognized event shape on', channel, event);
      return;
    }

    try {
      if (event.type === 'log') {
        const log = await appendLogLine(deploymentId, event);
        io.to(roomFor(deploymentId)).emit('log', log);
      } else {
        const updated = await transitionDeploymentStatus(deploymentId, event.status, {
          reason: event.reason,
          url: event.url,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
          errorStep: event.errorStep,
        });
        if (updated) {
          io.to(roomFor(deploymentId)).emit('status', { status: updated.status, url: updated.url });
        }
      }
    } catch (err) {
      // A malformed or late-arriving event must never crash the relay —
      // every OTHER in-flight deployment's logs depend on this exact same
      // subscriber connection staying alive.
      console.error('[LOG_RELAY] Failed to process event for deployment', deploymentId, err);
    }
  });
}
