import {
  type EntityManager,
  type EntitySchema,
  IsolationLevel,
  LockMode,
  type MikroORM,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';
import { ConflictError, ValidationError } from '../../application/errors';
import type {
  LedgerPage,
  LedgerTotals,
  PendingReferenceCandidate,
  WageringStore,
  WageringUnitOfWork,
} from '../../application/ports';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import type { InboxMessage } from '../../domain/inbox-message';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';
import { translateDatabaseError } from './database-errors';
import { LedgerEntryMapper, OutboxMapper, WagerTransactionMapper, WalletMapper } from './mappers';
import {
  InboxSchema,
  LedgerEntrySchema,
  OutboxSchema,
  WagerTransactionSchema,
  WalletSchema,
} from './records';

export interface StoreOptions {
  /** Quanto uma requisição espera pelo lock da wallet antes de desistir (503). */
  lockTimeoutMs: number;
}

const DEFAULT_OPTIONS: StoreOptions = { lockTimeoutMs: 5_000 };

/** Leituras sem identity map: cada consulta reflete o banco, nunca um cache. */
const FRESH = { disableIdentityMap: true } as const;

export class MikroOrmWageringStore implements WageringStore {
  private readonly options: StoreOptions;

  constructor(
    private readonly orm: MikroORM,
    options: Partial<StoreOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async transaction<T>(fn: (uow: WageringUnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // SET LOCAL vale só para esta transação.
          await em.execute(`set local lock_timeout = ${Math.trunc(this.options.lockTimeoutMs)}`);
          return fn(new MikroOrmUnitOfWork(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  private async read<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await fn(this.orm.em.fork());
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  findWallet(walletId: string): Promise<Wallet | undefined> {
    return this.read(async (em) => {
      const r = await em.findOne(WalletSchema, { id: walletId }, FRESH);
      return r ? WalletMapper.toDomain(r) : undefined;
    });
  }

  findTransactionById(id: string): Promise<WagerTransaction | undefined> {
    return this.read(async (em) => {
      const r = await em.findOne(WagerTransactionSchema, { id }, FRESH);
      return r ? WagerTransactionMapper.toDomain(r) : undefined;
    });
  }

  findTransactionByProviderExternal(providerId: string, externalId: string): Promise<WagerTransaction | undefined> {
    return this.read(async (em) => {
      const r = await em.findOne(WagerTransactionSchema, { providerId, externalTransactionId: externalId }, FRESH);
      return r ? WagerTransactionMapper.toDomain(r) : undefined;
    });
  }

  /**
   * Cursor opaco = base64url de {"s": seq}. `seq` é uma identity monotônica,
   * então novos lançamentos nunca aparecem "antes" de um cursor já entregue.
   */
  ledgerPage(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    return this.read(async (em) => {
      const rows = await em.find(
        LedgerEntrySchema,
        { walletId, ...(after ? { seq: { $gt: after } } : {}) },
        { orderBy: { seq: 'asc' }, limit: limit + 1, ...FRESH },
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page.map(LedgerEntryMapper.toDomain),
        nextCursor: rows.length > limit && last?.seq ? encodeCursor(String(last.seq)) : undefined,
      };
    });
  }

  ledgerTotals(walletId: string): Promise<LedgerTotals | undefined> {
    return this.read(async (em) => {
      const [row] = await em.execute<{ balance: string; currency: string; calculated: string; entries: string }[]>(
        `select w.balance::text as balance, w.currency,
                coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(21,2)::text as calculated,
                count(l.id)::text as entries
           from wallets w
           left join wallet_ledger_entries l on l.wallet_id = w.id
          where w.id = ?
          group by w.id`,
        [walletId],
      );
      if (!row) return undefined;
      return {
        storedBalance: Money.from({ amount: row.balance, currency: row.currency }),
        calculatedBalance: signedMoney(row.calculated, row.currency),
        checkedEntries: Number(row.entries),
      };
    });
  }

  /**
   * Seleciona as PENDING_REFERENCE vencidas com FOR UPDATE SKIP LOCKED e empurra
   * `next_attempt_at` para frente (lease). Duas instâncias nunca pegam a mesma
   * linha ao mesmo tempo; se a instância morrer, a linha volta a vencer quando
   * o lease expira. Não toca na wallet, então não disputa lock com o submit.
   */
  claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<PendingReferenceCandidate[]> {
    return this.read(async (em) => {
      const rows = await em.execute<{ id: string; wallet_id: string }[]>(
        `update wager_transactions t
            set next_attempt_at = ?, updated_at = ?
          where t.id in (
            select id from wager_transactions
             where status = 'PENDING_REFERENCE' and next_attempt_at <= ?
             order by next_attempt_at
             limit ?
             for update skip locked)
        returning t.id, t.wallet_id`,
        [new Date(now.getTime() + leaseMs), now, now, limit],
      );
      return rows.map((r) => ({ transactionId: r.id, walletId: r.wallet_id }));
    });
  }
}

// ============================================================================

class MikroOrmUnitOfWork implements WageringUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(
      WalletSchema,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, ...FRESH },
    );
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletSchema, WalletMapper.toRecord(wallet));
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConflictError(
          'WALLET_ALREADY_EXISTS',
          `player ${wallet.playerId} already has a ${wallet.currency} wallet`,
        );
      }
      throw error;
    }
  }

  async saveWalletBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    // Sob o lock pessimista isso não acontece; se acontecer, aborta a transação inteira.
    if (affected !== 1) {
      throw new Error(`wallet ${wallet.id} version check failed (expected ${expectedVersion})`);
    }
  }

  async findTransactionsByIdentity(key: string, providerId: string, externalId: string): Promise<WagerTransaction[]> {
    const rows = await this.em.find(
      WagerTransactionSchema,
      { $or: [{ idempotencyKey: key }, { providerId, externalTransactionId: externalId }] },
      FRESH,
    );
    return rows.map(WagerTransactionMapper.toDomain);
  }

  async findTransactionByProviderExternal(providerId: string, externalId: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(
      WagerTransactionSchema,
      { providerId, externalTransactionId: externalId },
      FRESH,
    );
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async findTransactionById(id: string, options: { forUpdate?: boolean } = {}): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(
      WagerTransactionSchema,
      { id },
      { ...FRESH, ...(options.forUpdate ? { lockMode: LockMode.PESSIMISTIC_WRITE } : {}) },
    );
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async insertTransaction(tx: WagerTransaction): Promise<boolean> {
    return insertOrIgnore(this.em, WagerTransactionSchema, WagerTransactionMapper.toRecord(tx));
  }

  async updatePendingTransaction(tx: WagerTransaction): Promise<void> {
    const r = WagerTransactionMapper.toRecord(tx);
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: tx.id, status: WagerTransactionStatus.PendingReference },
      {
        status: r.status,
        referenceTransactionId: r.referenceTransactionId,
        failureCode: r.failureCode,
        balanceAfter: r.balanceAfter,
        attempts: r.attempts,
        nextAttemptAt: r.nextAttemptAt,
        processedAt: r.processedAt,
        updatedAt: r.updatedAt,
      },
    );
    if (affected !== 1) throw new Error(`transaction ${tx.id} is no longer PENDING_REFERENCE`);
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  async wakeDependents(tx: WagerTransaction, at: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionSchema,
      {
        providerId: tx.providerId,
        referenceExternalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        status: WagerTransactionStatus.PendingReference,
        nextAttemptAt: { $gt: at },
      },
      { nextAttemptAt: at, updatedAt: at },
    );
  }

  async appendLedger(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, LedgerEntryMapper.toRecord(entry));
  }

  async enqueue(events: IntegrationEvent<unknown>[]): Promise<void> {
    if (events.length === 0) return;
    await this.em.insertMany(
      OutboxSchema,
      events.map((e) => OutboxMapper.toRecord(OutboxMessage.enqueue(e))),
    );
  }

  async receiveInbox(message: InboxMessage): Promise<boolean> {
    // Processada na mesma transação SQL que a registra.
    message.markProcessed(message.receivedAt);
    return insertOrIgnore(this.em, InboxSchema, {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
  }
}

// ============================================================================

/**
 * INSERT ... ON CONFLICT DO NOTHING RETURNING 1, montado a partir dos metadados
 * do ORM. Conflito de chave única não aborta a transação SQL (ao contrário de
 * capturar a exceção), então o chamador pode ler a linha vencedora em seguida.
 */
async function insertOrIgnore<T extends object>(
  em: EntityManager,
  schema: EntitySchema<T>,
  record: Partial<T>,
): Promise<boolean> {
  const meta = em.getMetadata().get(schema.meta.className);
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const [prop, value] of Object.entries(record)) {
    if (value === undefined) continue;
    const field = (meta.properties as Record<string, { fieldNames: string[] } | undefined>)[prop]?.fieldNames[0];
    if (!field) throw new Error(`unknown property ${prop} on ${meta.className}`);
    columns.push(`"${field}"`);
    values.push(value !== null && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value);
  }
  const rows = await em.execute<unknown[]>(
    `insert into "${meta.tableName}" (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})
     on conflict do nothing returning 1`,
    values,
  );
  return rows.length === 1;
}

function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq })).toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof parsed.s === 'string' && /^\d{1,19}$/.test(parsed.s)) return parsed.s;
  } catch {
    // cai no erro abaixo
  }
  throw new ValidationError(['cursor is invalid']);
}

/** Soma do ledger pode, em tese, ser negativa (divergência); Money.from só aceita positivos. */
function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}
