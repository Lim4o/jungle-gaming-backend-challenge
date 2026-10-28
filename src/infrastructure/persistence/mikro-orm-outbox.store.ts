import type { MikroORM } from '@mikro-orm/postgresql';
import type { OutboxStore } from '../../application/ports';
import { OutboxMessage } from '../../domain/outbox-message';
import { translateDatabaseError } from './database-errors';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

export class MikroOrmOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  /**
   * Um único UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED):
   * publishers concorrentes nunca recebem a mesma linha enquanto o lease vale.
   */
  claim(owner: string, now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    return this.run(async () => {
      const rows = await this.orm.em.fork().execute<OutboxRow[]>(
        `update outbox_messages o
            set locked_by = ?, locked_until = ?
          where o.id in (
            select id from outbox_messages
             where published_at is null
               and next_attempt_at <= ?
               and (locked_until is null or locked_until <= ?)
             order by occurred_at, id
             limit ?
             for update skip locked)
        returning o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts,
                  o.next_attempt_at, o.published_at`,
        [owner, new Date(now.getTime() + leaseMs), now, now, limit],
      );
      return rows
        .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())
        .map((r) =>
          OutboxMessage.rehydrate({
            id: r.id,
            aggregateId: r.aggregate_id,
            eventType: r.event_type,
            payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
            occurredAt: new Date(r.occurred_at),
            attempts: r.attempts,
            nextAttemptAt: new Date(r.next_attempt_at),
            publishedAt: r.published_at ? new Date(r.published_at) : undefined,
          }),
        );
    });
  }

  markPublished(messages: OutboxMessage[], owner: string): Promise<string[]> {
    if (messages.length === 0) return Promise.resolve([]);
    return this.run(async () => {
      const rows = await this.orm.em.fork().execute<{ id: string }[]>(
        `update outbox_messages
            set published_at = ?, locked_by = null, locked_until = null, last_error = null
          where id in (?) and published_at is null and locked_by = ?
        returning id`,
        [messages[0]!.publishedAt, messages.map((m) => m.id), owner],
      );
      return rows.map((r) => r.id);
    });
  }

  scheduleRetry(message: OutboxMessage, owner: string, error: string): Promise<void> {
    return this.run(async () => {
      await this.orm.em.fork().execute(
        `update outbox_messages
            set attempts = ?, next_attempt_at = ?, last_error = ?, locked_by = null, locked_until = null
          where id = ? and published_at is null and locked_by = ?`,
        [message.attempts, message.nextAttemptAt, error, message.id, owner],
      );
    });
  }

  stats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }> {
    return this.run(async () => {
      const [row] = await this.orm.em.fork().execute<{ pending: string; oldest: string | null }[]>(
        `select count(*)::text as pending,
                extract(epoch from (?::timestamptz - min(occurred_at)))::text as oldest
           from outbox_messages where published_at is null`,
        [now],
      );
      return { pending: Number(row?.pending ?? 0), oldestAgeSeconds: Math.max(0, Number(row?.oldest ?? 0)) };
    });
  }
}
