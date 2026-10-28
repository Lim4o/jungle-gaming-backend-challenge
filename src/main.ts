import { createApp } from './bootstrap';
import { LOGGER, type AppLogger } from './application/ports';
import { loadConfig } from './config';
import { errorFields } from './observability/logger';

const config = loadConfig();
const app = await createApp({ config });
const logger = app.get<AppLogger>(LOGGER);
await app.listen(config.port);
logger.info({ port: config.port, instanceId: config.instanceId }, 'wagering processor listening');

/**
 * Shutdown gracioso. `app.close()` dispara, em ordem: consumidor SQS para e
 * termina/devolve mensagens -> workers param -> HTTP fecha -> pool do banco fecha.
 * Sai com 0 quando tudo terminou; com 1 se estourar o prazo (o orquestrador
 * mata de qualquer jeito — mensagens não confirmadas voltam pela visibilidade).
 */
let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  const guard = setTimeout(() => {
    logger.error({ signal }, 'shutdown timed out; forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs + 5_000);
  try {
    await app.close();
    logger.info({ signal }, 'shutdown complete');
    clearTimeout(guard);
    process.exit(0);
  } catch (error) {
    logger.error({ signal, ...errorFields(error) }, 'shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
