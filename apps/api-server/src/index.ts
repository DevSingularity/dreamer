import { app } from './app';
import { env } from './lib/env';
import { startRealtimeGateway } from './realtime';

startRealtimeGateway();

app.listen(env.PORT, () => {
  console.log(`API server is running on port ${env.PORT}`);
});
