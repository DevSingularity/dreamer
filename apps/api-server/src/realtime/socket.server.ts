import { Server, type Socket } from 'socket.io';
import { verifyAccessToken } from '../auth/auth.tokens';
import { assertDeploymentOwnership } from '../deployments/deployment.service'; // concrete file — see §3.6 DASHBOARD_BACKEND_IMPL.md
import { env } from '../lib/env';

interface AuthedSocket extends Socket {
  userId?: string;
}

export function roomFor(deploymentId: string): string {
  return `deployment:${deploymentId}`;
}

/**
 * One Socket.IO server for the whole process, created once and handed to
 * log-relay.ts below — the only thing that ever emits through it. Stays on
 * its own port (9002, matching the prototype's apps/frontend
 * `io("http://localhost:9002")` client in app/demo/page.tsx) rather than
 * attaching to the Express app's HTTP server, so a burst of build-log
 * traffic can never compete with API request handling on the same listener.
 */
export function createSocketServer(): Server {
  const io = new Server({ cors: { origin: env.FRONTEND_URL, credentials: true } });

  // Auth happens ONCE, at connection time — not re-checked per event. A
  // socket that never presented a valid access token never even reaches the
  // 'subscribe' handler below; Socket.IO rejects the connection outright.
  io.use((socket: AuthedSocket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('UNAUTHORIZED'));

    try {
      const payload = verifyAccessToken(token);
      socket.userId = payload.sub;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: AuthedSocket) => {
    socket.on('subscribe', async (deploymentId: string) => {
      // The access token only proves WHO is asking — not that they're
      // allowed to watch THIS deployment's logs. Skipping this re-check is
      // the multi-tenant version of an IDOR bug: any logged-in user could
      // otherwise read any other user's build output by guessing a UUID and
      // emitting 'subscribe' with it — exactly the gap the unauthenticated
      // prototype (app/demo/page.tsx's socket.emit('subscribe', ...)) had,
      // harmlessly, before there were multiple users to leak data between.
      try {
        await assertDeploymentOwnership(deploymentId, socket.userId!);
        socket.join(roomFor(deploymentId));
      } catch {
        socket.emit('error', { message: 'Not found or not authorized' });
      }
    });

    socket.on('unsubscribe', (deploymentId: string) => {
      socket.leave(roomFor(deploymentId));
    });
  });

  return io;
}
