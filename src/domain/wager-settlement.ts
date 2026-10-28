import { InsufficientFundsError } from './errors';
import type { EventContext, IntegrationEvent } from './events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './events/wagering-events';
import { FailureCode } from './failure-code';
import type { ExponentialBackoff } from './retry-policy';
import type { Wallet } from './wallet';
import type { WalletLedgerEntry } from './wallet-ledger-entry';
import { WagerTransaction, WagerTransactionStatus } from './wager-transaction';

export interface SettlementInput {
  transaction: WagerTransaction;
  /** Wallet já travada pelo chamador (lock da unidade de concorrência). */
  wallet: Wallet;
  /** Resolvida por (providerId, referenceExternalTransactionId); ausente se não existe. */
  reference?: WagerTransaction;
  /** A referência já tem uma reversão PROCESSED (regra 4). */
  referenceAlreadyReversed: boolean;
  referenceRetry: ExponentialBackoff;
  now: Date;
  context: EventContext;
}

export interface SettlementOutcome {
  status: WagerTransactionStatus;
  ledgerEntry?: WalletLedgerEntry;
  events: IntegrationEvent<unknown>[];
}

/**
 * Regras de negócio da seção 7, puras (sem I/O). Muta `transaction` e
 * `wallet` e devolve o lançamento e os eventos que o chamador deve persistir
 * na MESMA transação SQL.
 */
export function settleWager(input: SettlementInput): SettlementOutcome {
  const { transaction: tx, wallet, reference, now, context } = input;

  const reject = (code: FailureCode): SettlementOutcome => {
    tx.reject(code, now, wallet.balance);
    return {
      status: tx.status,
      events: [WagerTransactionRejected.from(tx, context)],
    };
  };

  if (wallet.id !== tx.walletId || wallet.playerId !== tx.playerId) {
    return reject(FailureCode.WalletPlayerMismatch);
  }
  if (wallet.currency !== tx.money.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  if (tx.referenceExternalTransactionId) {
    if (WagerTransaction.isAwaitable(reference)) {
      return awaitReference(input);
    }
    const code = tx.checkReference(reference!);
    if (code) return reject(code);
    if (tx.isReversal() && input.referenceAlreadyReversed) {
      return reject(FailureCode.ReferenceAlreadyReversed);
    }
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, now, wallet.balance);
    return { status: tx.status, events: [WagerTransactionProcessed.from(tx, context)] };
  }

  let entry: WalletLedgerEntry;
  try {
    entry = wallet.move(tx.ledgerDirectionFor(reference), tx.money, tx.id, now);
  } catch (error) {
    if (error instanceof InsufficientFundsError) return reject(tx.insufficientFundsCode());
    throw error;
  }

  tx.markProcessed(reference?.id, now, wallet.balance);
  return {
    status: tx.status,
    ledgerEntry: entry,
    events: [
      WagerTransactionProcessed.from(tx, context),
      WalletBalanceChanged.from(wallet, entry, context),
    ],
  };
}

/**
 * Referência ausente (ou ela mesma aguardando): primeira vez vira
 * PENDING_REFERENCE e publica evento; nas tentativas do worker reagenda com
 * backoff; esgotado o limite, REJECTED com REFERENCE_NOT_FOUND.
 */
function awaitReference(input: SettlementInput): SettlementOutcome {
  const { transaction: tx, wallet, now, context, referenceRetry } = input;
  const isFirst = tx.status === WagerTransactionStatus.Pending;

  if (!isFirst && referenceRetry.isExhausted(tx.attempts + 1)) {
    tx.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
    return { status: tx.status, events: [WagerTransactionRejected.from(tx, context)] };
  }

  const attempt = isFirst ? 0 : tx.attempts + 1;
  tx.markPendingReference(referenceRetry.nextAttemptAt(attempt, now), now, wallet.balance);
  return {
    status: tx.status,
    events: isFirst ? [WagerTransactionPendingReference.from(tx, context)] : [],
  };
}
