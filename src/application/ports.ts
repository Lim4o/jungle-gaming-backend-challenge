import type { IntegrationEvent } from '../domain/events/integration-event';
import type { InboxMessage } from '../domain/inbox-message';
import type { Money } from '../domain/money';
import type { OutboxMessage } from '../domain/outbox-message';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { WagerTransaction } from '../domain/wager-transaction';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * Operações disponíveis DENTRO de uma transação SQL. Tudo o que é escrito
 * por um mesmo `WageringStore.transaction` é confirmado junto ou descartado
 * junto: inbox, transação, saldo, ledger e outbox.
 */
export interface WageringUnitOfWork {
  /** SELECT ... FOR UPDATE da linha da wallet. Unidade de concorrência. */
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  insertWallet(wallet: Wallet): Promise<void>;
  /** UPDATE condicionado à version anterior; lança se nenhuma linha mudou. */
  saveWalletBalance(wallet: Wallet, expectedVersion: number): Promise<void>;

  /**
   * Busca por idempotency key OU por (provider, externalId) num ÚNICO comando
   * SQL — um único snapshot. Duas consultas separadas em READ COMMITTED podem
   * enxergar um commit concorrente "no meio" e gerar um falso conflito.
   */
  findTransactionsByIdentity(key: string, providerId: string, externalId: string): Promise<WagerTransaction[]>;
  findTransactionByProviderExternal(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  findTransactionById(id: string, options?: { forUpdate?: boolean }): Promise<WagerTransaction | undefined>;
  /**
   * INSERT ... ON CONFLICT DO NOTHING. Devolve `false` se a idempotency key ou
   * (provider, externalId) já existir — sem abortar a transação SQL.
   */
  insertTransaction(tx: WagerTransaction): Promise<boolean>;
  /** Atualiza uma transação que ainda estava PENDING_REFERENCE. */
  updatePendingTransaction(tx: WagerTransaction): Promise<void>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Antecipa a próxima tentativa de quem estava esperando esta transação. */
  wakeDependents(tx: WagerTransaction, at: Date): Promise<number>;

  appendLedger(entry: WalletLedgerEntry): Promise<void>;
  enqueue(events: IntegrationEvent<unknown>[]): Promise<void>;

  /**
   * Registra a mensagem no inbox (INSERT ... ON CONFLICT DO NOTHING).
   * `false` = já recebida antes por este consumidor.
   */
  receiveInbox(message: InboxMessage): Promise<boolean>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

export interface LedgerTotals {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface PendingReferenceCandidate {
  transactionId: string;
  walletId: string;
}

export interface WageringStore {
  transaction<T>(fn: (uow: WageringUnitOfWork) => Promise<T>): Promise<T>;

  findWallet(walletId: string): Promise<Wallet | undefined>;
  findTransactionById(id: string): Promise<WagerTransaction | undefined>;
  findTransactionByProviderExternal(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  ledgerPage(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage>;
  ledgerTotals(walletId: string): Promise<LedgerTotals | undefined>;

  /** Transações PENDING_REFERENCE vencidas, com lease para não serem pegas por outra instância. */
  claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<PendingReferenceCandidate[]>;
}

/**
 * Outbox: cada instância "aluga" (lease) um lote de eventos pendentes com
 * FOR UPDATE SKIP LOCKED. Se morrer, o lease expira e outra instância assume.
 */
export interface OutboxStore {
  claim(owner: string, now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  /** `false` se o lease foi perdido (outra instância já assumiu). */
  markPublished(message: OutboxMessage, owner: string): Promise<boolean>;
  scheduleRetry(message: OutboxMessage, owner: string, error: string): Promise<void>;
  stats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }>;
}

export interface PublishResult {
  published: string[];
  failed: { id: string; error: string }[];
}

export interface EventPublisher {
  publish(messages: OutboxMessage[]): Promise<PublishResult>;
}

/** Sinais de negócio/operação. Implementação real em observability/. */
export interface WageringTelemetry {
  transactionSettled(status: string, kind: string, source: string): void;
  duplicateDetected(kind: 'idempotent_replay' | 'idempotency_conflict' | 'inbox_duplicate'): void;
  lockConflict(reason: string): void;
  processingLatency(source: string, seconds: number): void;
  reconciliationChecked(consistent: boolean): void;
}

export const noopTelemetry: WageringTelemetry = {
  transactionSettled: () => {},
  duplicateDetected: () => {},
  lockConflict: () => {},
  processingLatency: () => {},
  reconciliationChecked: () => {},
};

/** Log estruturado. Só identificadores e códigos — nunca payload financeiro completo. */
export interface AppLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  debug(fields: Record<string, unknown>, message: string): void;
}

export const silentLogger: AppLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

export const WAGERING_STORE = Symbol('WageringStore');
export const LOGGER = Symbol('AppLogger');
export const TELEMETRY = Symbol('WageringTelemetry');
export const CLOCK = Symbol('Clock');
