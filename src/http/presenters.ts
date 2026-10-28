import type { SubmitWagerResult } from '../application/wagering.service';
import type { ReconciliationReport } from '../application/wagering-queries';
import type { LedgerPage } from '../application/ports';
import { FAILURE_ACTION } from '../domain/failure-code';
import type { Wallet } from '../domain/wallet';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';

/**
 * Status HTTP por resultado da transação, iguais para resposta nova e replay
 * (só `idempotentReplay` muda). Ver tabela completa no ARCHITECTURE.md.
 */
export function httpStatusFor(tx: WagerTransaction): number {
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      return 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export function walletView(w: Wallet) {
  return { id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version };
}

export function submitView(result: SubmitWagerResult) {
  const tx = result.transaction;
  return {
    transactionId: tx.id,
    status: tx.status,
    ...(tx.observedBalance ? { balance: tx.observedBalance.toJSON() } : {}),
    ...(tx.failureCode ? { failureCode: tx.failureCode, action: FAILURE_ACTION[tx.failureCode] } : {}),
    ...(tx.status === WagerTransactionStatus.PendingReference && tx.nextAttemptAt
      ? { nextAttemptAt: tx.nextAttemptAt.toISOString() }
      : {}),
    idempotentReplay: result.idempotentReplay,
  };
}

export function transactionView(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
    ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
    status: tx.status,
    ...(tx.failureCode ? { failureCode: tx.failureCode, action: FAILURE_ACTION[tx.failureCode] } : {}),
    ...(tx.observedBalance ? { balance: tx.observedBalance.toJSON() } : {}),
    attempts: tx.attempts,
    ...(tx.nextAttemptAt ? { nextAttemptAt: tx.nextAttemptAt.toISOString() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}

export function ledgerView(page: LedgerPage) {
  return {
    entries: page.entries.map((e) => ({
      id: e.id,
      transactionId: e.transactionId,
      direction: e.direction,
      money: e.money.toJSON(),
      balanceBefore: e.balanceBefore.toJSON(),
      balanceAfter: e.balanceAfter.toJSON(),
      createdAt: e.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor ?? null,
  };
}

export function reconciliationView(r: ReconciliationReport) {
  return {
    walletId: r.walletId,
    storedBalance: r.storedBalance.toJSON(),
    calculatedBalance: r.calculatedBalance.toJSON(),
    difference: r.difference.toJSON(),
    consistent: r.consistent,
    checkedEntries: r.checkedEntries,
  };
}
