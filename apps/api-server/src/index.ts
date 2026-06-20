import { app } from './app';
import { env } from './lib/env';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';

const subscriber = new Redis(env.REDIS_URL);
const io = new Server({ cors: { origin: env.FRONTEND_URL } });

io.on('connection', (socket: Socket) => {
  socket.on('subscribe', (channel: string) => {
    socket.join(channel);
    socket.emit('message', `Joined ${channel}`);
  });
});

io.listen(9002);
console.log('Socket Server 9002');

async function initRedisSubscribe(): Promise<void> {
  console.log('Subscribed to logs....');
  await subscriber.psubscribe('logs:*');
  subscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
    io.to(channel).emit('message', message);
  });
}

initRedisSubscribe();

app.listen(env.PORT, () => {
  console.log(`API server is running on port ${env.PORT}`);
});