import { DEFAULT_OUTBOX_RETRY, type ExponentialBackoff } from '../domain/retry-policy';
import type { OutboxMessage } from '../domain/outbox-message';
import {
  type AppLogger,
  type Clock,
  type EventPublisher,
  type OutboxStore,
  silentLogger,
  systemClock,
} from './ports';

export interface OutboxRelayOptions {
  owner: string;
  batchSize: number;
  leaseMs: number;
  retry?: ExponentialBackoff;
  clock?: Clock;
  logger?: AppLogger;
  onPublished?: (message: OutboxMessage) => void;
  onRetry?: (message: OutboxMessage) => void;
}

export interface RelayTickResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Publica eventos confirmados (transactional outbox). Garantia: at-least-once.
 *
 * Cenário da seção 11: commit feito, processo morre antes de publicar ->
 * o evento continua `published_at IS NULL`; quando o lease expira outra
 * instância o pega e publica. Se a primeira chegou a publicar mas morreu antes
 * de marcar, o evento sai duas vezes com o MESMO eventId — consumidores
 * deduplicam por eventId (e o SQS FIFO deduplica pelo MessageDeduplicationId).
 */
export class OutboxRelay {
  private readonly retry: ExponentialBackoff;
  private readonly clock: Clock;
  private readonly logger: AppLogger;

  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxRelayOptions,
  ) {
    this.retry = options.retry ?? DEFAULT_OUTBOX_RETRY;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
  }

  async tick(): Promise<RelayTickResult> {
    const now = this.clock.now();
    const messages = await this.store.claim(this.options.owner, now, this.options.batchSize, this.options.leaseMs);
    if (messages.length === 0) return { claimed: 0, published: 0, failed: 0 };

    let result;
    try {
      result = await this.publisher.publish(messages);
    } catch (error) {
      // Broker fora do ar: tudo volta para a fila com backoff.
      const reason = (error as Error).message ?? String(error);
      result = { published: [], failed: messages.map((m) => ({ id: m.id, error: reason })) };
    }

    const byId = new Map(messages.map((m) => [m.id, m]));
    const at = this.clock.now();
    for (const id of result.published) {
      const message = byId.get(id)!;
      message.markPublished(at);
      const kept = await this.store.markPublished(message, this.options.owner);
      if (!kept) this.logger.warn({ eventId: id }, 'outbox lease lost after publish; event may be duplicated');
      this.options.onPublished?.(message);
    }
    for (const { id, error } of result.failed) {
      const message = byId.get(id)!;
      message.scheduleRetry(at, this.retry);
      await this.store.scheduleRetry(message, this.options.owner, error.slice(0, 500));
      this.options.onRetry?.(message);
      this.logger.warn(
        { eventId: id, eventType: message.eventType, attempts: message.attempts, error },
        'outbox publish failed; scheduled retry',
      );
    }
    return { claimed: messages.length, published: result.published.length, failed: result.failed.length };
  }
}
