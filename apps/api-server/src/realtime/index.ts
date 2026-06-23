import { startLogRelay } from './log-relay';
import { createSocketServer } from './socket.server';

const SOCKET_PORT = 9002; // unchanged from the prototype — apps/frontend's socket client already points here

/** Called once from src/index.ts at process boot. */
export async function startRealtimeGateway(): Promise<void> {
  const io = createSocketServer();
  io.listen(SOCKET_PORT);
  console.log(`Realtime gateway listening on port ${SOCKET_PORT}`);

  await startLogRelay(io);
  console.log(`Subscribed to deployment:* for log + status relay`);
}
