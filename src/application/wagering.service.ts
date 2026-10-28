import { DomainError } from '../domain/errors';
import { type EventContext } from '../domain/events/integration-event';
import { WalletBalanceChanged } from '../domain/events/wagering-events';
import { FailureCode } from '../domain/failure-code';
import { InboxMessage } from '../domain/inbox-message';
import { canonicalJson, sha256, wagerPayloadHash } from '../domain/payload-hash';
import { DEFAULT_REFERENCE_RETRY, type ExponentialBackoff } from '../domain/retry-policy';
import { Wallet } from '../domain/wallet';
import { settleWager, type SettlementOutcome } from '../domain/wager-settlement';
import { WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import type { CreateWalletCommand, SubmitWagerCommand } from './commands';
import { ConflictError, TransientInfrastructureError, ValidationError, walletNotFound } from './errors';
import {
  type AppLogger,
  type Clock,
  type PendingReferenceCandidate,
  type WageringStore,
  type WageringTelemetry,
  type WageringUnitOfWork,
  noopTelemetry,
  silentLogger,
  systemClock,
} from './ports';

const LOCK_CONFLICT_REASONS = new Set(['lock_timeout', 'deadlock', 'serialization_failure']);

export interface SubmitWagerResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

export type PendingReferenceResult = 'processed' | 'rejected' | 'rescheduled' | 'skipped';

export interface WageringServiceOptions {
  clock?: Clock;
  telemetry?: WageringTelemetry;
  logger?: AppLogger;
  referenceRetry?: ExponentialBackoff;
  newId?: () => string;
}

/**
 * Use cases de escrita. HTTP e SQS chamam exatamente os mesmos métodos.
 *
 * Estratégia de concorrência (ver ARCHITECTURE.md):
 *  - a unidade de concorrência é a wallet: `SELECT ... FOR UPDATE` na linha
 *    dela serializa tudo que mexe naquele saldo, em qualquer instância;
 *  - wallets diferentes não disputam lock nenhum (sem lock global);
 *  - a idempotência é verificada antes do lock (caminho rápido do replay) e de
 *    novo depois dele (quem esperou o lock enxerga o commit de quem chegou antes);
 *  - os índices únicos do banco são a garantia final (`ON CONFLICT DO NOTHING`).
 */
export class WageringService {
  private readonly clock: Clock;
  private readonly telemetry: WageringTelemetry;
  private readonly logger: AppLogger;
  private readonly referenceRetry: ExponentialBackoff;
  private readonly newId: () => string;

  constructor(
    private readonly store: WageringStore,
    options: WageringServiceOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.telemetry = options.telemetry ?? noopTelemetry;
    this.logger = options.logger ?? silentLogger;
    this.referenceRetry = options.referenceRetry ?? DEFAULT_REFERENCE_RETRY;
    this.newId = options.newId ?? (() => Bun.randomUUIDv7());
  }

  // =================================================================== wallets

  async createWallet(cmd: CreateWalletCommand): Promise<Wallet> {
    const now = this.clock.now();
    const walletId = this.newId();
    const openingId = this.newId();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: cmd.playerId,
      initialBalance: cmd.initialBalance,
      openingTransactionId: openingId,
      at: now,
    });

    await this.inTransaction(async (uow) => {
      await uow.insertWallet(wallet);
      if (!openingEntry) return;

      // Saldo inicial > 0: transação interna OPENING + CREDIT, na mesma transação SQL.
      const opening = WagerTransaction.opening({
        id: openingId,
        walletId,
        playerId: cmd.playerId,
        money: cmd.initialBalance,
        payloadHash: sha256(canonicalJson({ kind: 'OPENING', walletId, money: cmd.initialBalance.toJSON() })),
        at: now,
      });
      await uow.insertTransaction(opening);
      await uow.appendLedger(openingEntry);
      await uow.enqueue([
        WalletBalanceChanged.from(wallet, openingEntry, { correlationId: cmd.correlationId, occurredAt: now }),
      ]);
    });

    this.logger.info(
      { correlationId: cmd.correlationId, walletId, playerId: cmd.playerId },
      'wallet created',
    );
    return wallet;
  }

  // ============================================================== transações

  async submit(cmd: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const startedAt = performance.now();
    const source = cmd.inbox ? 'sqs' : 'http';
    const payloadHash = wagerPayloadHash(cmd);
    const now = this.clock.now();
    const draft = this.draft(cmd, payloadHash, now);
    const context: EventContext = {
      correlationId: cmd.correlationId,
      causationId: cmd.causationId,
      occurredAt: now,
    };

    const result = await this.inTransaction(async (uow): Promise<SubmitWagerResult> => {
      if (cmd.inbox) {
        const fresh = await uow.receiveInbox(
          InboxMessage.receive({ ...cmd.inbox, receivedAt: now }),
        );
        if (!fresh) this.telemetry.duplicateDetected('inbox_duplicate');
      }

      // 1) caminho rápido: replay sem tocar no lock da wallet.
      const known = await this.findExisting(uow, cmd, payloadHash);
      if (known) return { transaction: known, idempotentReplay: true };

      // 2) lock da unidade de concorrência.
      const wallet = await uow.lockWallet(cmd.walletId);
      if (!wallet) throw walletNotFound(cmd.walletId);

      // 3) quem esperou o lock pode encontrar o commit de uma requisição idêntica.
      const committedMeanwhile = await this.findExisting(uow, cmd, payloadHash);
      if (committedMeanwhile) return { transaction: committedMeanwhile, idempotentReplay: true };

      const reference = await this.resolveReference(uow, draft);
      const versionBefore = wallet.version;
      const outcome = settleWager({
        transaction: draft,
        wallet,
        reference: reference?.transaction,
        referenceAlreadyReversed: reference?.alreadyReversed ?? false,
        referenceRetry: this.referenceRetry,
        now,
        context,
      });

      // 4) garantia final: índices únicos. Nada foi escrito ainda além do inbox.
      if (!(await uow.insertTransaction(draft))) {
        const winner = await this.findExisting(uow, cmd, payloadHash);
        if (!winner) throw new TransientInfrastructureError('idempotency race could not be resolved');
        return { transaction: winner, idempotentReplay: true };
      }

      await this.persistOutcome(uow, draft, wallet, versionBefore, outcome, now);
      return { transaction: draft, idempotentReplay: false };
    });

    this.observe(result, cmd, source, startedAt);
    return result;
  }

  /**
   * Reprocessa uma transação PENDING_REFERENCE (chamado pelo worker agendado).
   * Ordem de locks igual à do submit — wallet primeiro, depois a linha da
   * transação —, então workers e requisições não entram em deadlock.
   */
  async retryPendingReference(candidate: PendingReferenceCandidate): Promise<PendingReferenceResult> {
    const now = this.clock.now();
    return this.inTransaction(async (uow) => {
      const wallet = await uow.lockWallet(candidate.walletId);
      const tx = await uow.findTransactionById(candidate.transactionId, { forUpdate: true });
      if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) return 'skipped';

      const reference = await this.resolveReference(uow, tx);
      const versionBefore = wallet.version;
      const outcome = settleWager({
        transaction: tx,
        wallet,
        reference: reference?.transaction,
        referenceAlreadyReversed: reference?.alreadyReversed ?? false,
        referenceRetry: this.referenceRetry,
        now,
        context: { correlationId: tx.id, causationId: tx.id, occurredAt: now },
      });

      await uow.updatePendingTransaction(tx);
      await this.persistOutcome(uow, tx, wallet, versionBefore, outcome, now);

      this.telemetry.transactionSettled(tx.status, tx.kind, 'reference_worker');
      this.logger.info(
        {
          transactionId: tx.id,
          walletId: tx.walletId,
          providerId: tx.providerId,
          status: tx.status,
          failureCode: tx.failureCode,
          attempts: tx.attempts,
        },
        'pending reference retried',
      );
      const settled = tx.status as WagerTransactionStatus; // settleWager mudou o status
      if (settled === WagerTransactionStatus.Processed) return 'processed';
      if (settled === WagerTransactionStatus.Rejected) return 'rejected';
      return 'rescheduled';
    });
  }

  /**
   * Erro permanente (não transitório, não regra de negócio) ao reprocessar:
   * a transação vira FAILED — terminal e auditável — em vez de ficar presa.
   */
  async failPendingReference(candidate: PendingReferenceCandidate, reason: string): Promise<boolean> {
    const now = this.clock.now();
    return this.inTransaction(async (uow) => {
      await uow.lockWallet(candidate.walletId);
      const tx = await uow.findTransactionById(candidate.transactionId, { forUpdate: true });
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return false;
      tx.fail(FailureCode.PermanentProcessingError, now);
      await uow.updatePendingTransaction(tx);
      this.telemetry.transactionSettled(tx.status, tx.kind, 'reference_worker');
      this.logger.error(
        { transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId, reason },
        'pending reference marked FAILED',
      );
      return true;
    });
  }

  // ================================================================= helpers

  /** Transação SQL única; disputa de lock vira métrica antes de subir como 503/retry. */
  private async inTransaction<T>(fn: (uow: WageringUnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await this.store.transaction(fn);
    } catch (error) {
      if (error instanceof TransientInfrastructureError && LOCK_CONFLICT_REASONS.has(error.reason)) {
        this.telemetry.lockConflict(error.reason);
      }
      throw error;
    }
  }

  private draft(cmd: SubmitWagerCommand, payloadHash: string, now: Date): WagerTransaction {
    try {
      return WagerTransaction.create({
        id: this.newId(),
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash,
        walletId: cmd.walletId,
        playerId: cmd.playerId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind: cmd.kind,
        money: cmd.money,
        referenceExternalTransactionId: cmd.referenceExternalTransactionId,
        createdAt: now,
      });
    } catch (error) {
      // Regras de formato do domínio (ex.: REFUND sem referência) são payload inválido.
      if (error instanceof DomainError) throw new ValidationError([error.message]);
      throw error;
    }
  }

  /**
   * Mesma key + mesmo payload => replay. Mesma key + payload diferente, ou o
   * mesmo (provider, externalId) sob outra key => conflito, nunca replay.
   */
  private async findExisting(
    uow: WageringUnitOfWork,
    cmd: SubmitWagerCommand,
    payloadHash: string,
  ): Promise<WagerTransaction | undefined> {
    const matches = await uow.findTransactionsByIdentity(
      cmd.idempotencyKey,
      cmd.providerId,
      cmd.externalTransactionId,
    );
    const byKey = matches.find((t) => t.idempotencyKey === cmd.idempotencyKey);
    if (byKey) {
      if (byKey.matchesPayload(payloadHash)) return byKey;
      this.telemetry.duplicateDetected('idempotency_conflict');
      throw new ConflictError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key already used with a different payload',
        { transactionId: byKey.id },
      );
    }
    const byExternal = matches[0];
    if (byExternal) {
      this.telemetry.duplicateDetected('idempotency_conflict');
      throw new ConflictError(
        'EXTERNAL_TRANSACTION_ID_REUSED',
        'externalTransactionId already registered for this provider under another Idempotency-Key',
        { transactionId: byExternal.id },
      );
    }
    return undefined;
  }

  private async resolveReference(
    uow: WageringUnitOfWork,
    tx: WagerTransaction,
  ): Promise<{ transaction?: WagerTransaction; alreadyReversed: boolean } | undefined> {
    if (!tx.referenceExternalTransactionId) return undefined;
    const reference = await uow.findTransactionByProviderExternal(tx.providerId, tx.referenceExternalTransactionId);
    const alreadyReversed =
      reference !== undefined && tx.isReversal() ? await uow.hasProcessedReversal(reference.id) : false;
    return { transaction: reference, alreadyReversed };
  }

  /** Ledger + saldo + eventos na mesma transação SQL da mudança de estado. */
  private async persistOutcome(
    uow: WageringUnitOfWork,
    tx: WagerTransaction,
    wallet: Wallet,
    versionBefore: number,
    outcome: SettlementOutcome,
    now: Date,
  ): Promise<void> {
    if (outcome.ledgerEntry) {
      await uow.appendLedger(outcome.ledgerEntry);
      await uow.saveWalletBalance(wallet, versionBefore);
    }
    await uow.enqueue(outcome.events);
    if (tx.status === WagerTransactionStatus.Processed) {
      await uow.wakeDependents(tx, now);
    }
  }

  private observe(result: SubmitWagerResult, cmd: SubmitWagerCommand, source: string, startedAt: number): void {
    const tx = result.transaction;
    if (result.idempotentReplay) {
      this.telemetry.duplicateDetected('idempotent_replay');
    } else {
      this.telemetry.transactionSettled(tx.status, tx.kind, source);
    }
    this.telemetry.processingLatency(source, (performance.now() - startedAt) / 1000);
    this.logger.info(
      {
        correlationId: cmd.correlationId,
        messageId: cmd.inbox?.messageId,
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode,
        idempotentReplay: result.idempotentReplay,
      },
      'wager transaction handled',
    );
  }
}
