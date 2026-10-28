import { createApp } from './bootstrap';
import { LOGGER, type AppLogger } from './application/ports';
import { loadConfig } from './config';

const config = loadConfig();
const app = await createApp({ config });
await app.listen(config.port);
app
  .get<AppLogger>(LOGGER)
  .info({ port: config.port, instanceId: config.instanceId }, 'wagering processor listening');
