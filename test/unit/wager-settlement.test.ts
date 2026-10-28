import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import {
  type WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wager-transaction';
import { settleWager } from '../../src/domain/wager-settlement';
import { CTX, NOW, PLAYER, RETRY, WALLET, brl, usd, wager, wallet } from '../support/builders';

function settle(w: Wallet, tx: WagerTransaction, reference?: WagerTransaction, referenceAlreadyReversed = false) {
  return settleWager({ transaction: tx, wallet: w, reference, referenceAlreadyReversed, referenceRetry: RETRY, now: NOW, context: CTX });
}
const types = (o: { events: { eventType: string }[] }) => o.events.map((e) => e.eventType);

function processed(w: Wallet, kind: K, amount: string, externalTransactionId: string) {
  const tx = wager(kind, amount, { externalTransactionId });
  settle(w, tx);
  expect(tx.status).toBe(S.Processed);
  return tx;
}

describe('BET', () => {
  test('debita, gera 1 DEBIT e os eventos Processed + BalanceChanged', () => {
    const w = wallet('100.00');
    const out = settle(w, wager(K.Bet, '25.00'));
    expect(out.status).toBe(S.Processed);
    expect(w.balance.amount).toBe('75.00');
    expect(out.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(types(out)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('saldo insuficiente: REJECTED INSUFFICIENT_FUNDS, sem ledger e sem mudar saldo', () => {
    const w = wallet('20.00');
    const tx = wager(K.Bet, '80.00');
    const out = settle(w, tx);
    expect(out.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(out.ledgerEntry).toBeUndefined();
    expect(w.balance.amount).toBe('20.00');
    expect(w.version).toBe(1);
    expect(types(out)).toEqual(['WagerTransactionRejected']);
  });

  test('cenário da seção 8 em sequência: 100 - 80 - 80 => uma aceita, outra rejeitada, saldo 20', () => {
    const w = wallet('100.00');
    const a = settle(w, wager(K.Bet, '80.00'));
    const b = settle(w, wager(K.Bet, '80.00'));
    expect([a.status, b.status]).toEqual([S.Processed, S.Rejected]);
    expect(w.balance.amount).toBe('20.00');
  });
});

describe('WIN', () => {
  test('credita', () => {
    const w = wallet('10.00');
    const out = settle(w, wager(K.Win, '50.00'));
    expect(w.balance.amount).toBe('60.00');
    expect(out.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
  });

  test('pode referenciar a BET da mesma rodada', () => {
    const w = wallet('100.00');
    const bet = processed(w, K.Bet, '10.00', 'bet-1');
    const win = wager(K.Win, '30.00', { referenceExternalTransactionId: 'bet-1' });
    settle(w, win, bet);
    expect(win.status).toBe(S.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(w.balance.amount).toBe('120.00');
  });
});

describe('LOSS', () => {
  test('registra o resultado sem mover saldo, sem ledger, com evento Processed', () => {
    const w = wallet('100.00');
    const out = settle(w, wager(K.Loss, '10.00'));
    expect(out.status).toBe(S.Processed);
    expect(out.ledgerEntry).toBeUndefined();
    expect(w.balance.amount).toBe('100.00');
    expect(w.version).toBe(1);
    expect(types(out)).toEqual(['WagerTransactionProcessed']);
  });
});

describe('REFUND', () => {
  test('credita o valor da BET de volta', () => {
    const w = wallet('100.00');
    const bet = processed(w, K.Bet, '40.00', 'bet-1');
    const refund = wager(K.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    const out = settle(w, refund, bet);
    expect(out.status).toBe(S.Processed);
    expect(w.balance.amount).toBe('100.00');
    expect(out.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
  });

  test('só uma vez: segunda reversão é REFERENCE_ALREADY_REVERSED', () => {
    const w = wallet('100.00');
    const bet = processed(w, K.Bet, '40.00', 'bet-1');
    const second = wager(K.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    settle(w, second, bet, true);
    expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(w.balance.amount).toBe('60.00');
  });

  test('valor diferente da BET é rejeitado', () => {
    const w = wallet('100.00');
    const bet = processed(w, K.Bet, '40.00', 'bet-1');
    const refund = wager(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' });
    settle(w, refund, bet);
    expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
  });
});

describe('ROLLBACK', () => {
  test('de BET credita', () => {
    const w = wallet('100.00');
    const bet = processed(w, K.Bet, '25.00', 'bet-1');
    const rb = wager(K.Rollback, '25.00', { referenceExternalTransactionId: 'bet-1' });
    const out = settle(w, rb, bet);
    expect(out.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.amount).toBe('100.00');
  });

  test('de WIN debita', () => {
    const w = wallet('100.00');
    const win = processed(w, K.Win, '50.00', 'win-1');
    const rb = wager(K.Rollback, '50.00', { referenceExternalTransactionId: 'win-1' });
    const out = settle(w, rb, win);
    expect(out.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.amount).toBe('100.00');
  });

  test('de WIN já gasto: REVERSAL_INSUFFICIENT_FUNDS, distinto de aposta sem saldo', () => {
    const w = wallet('0');
    const win = processed(w, K.Win, '50.00', 'win-1');
    processed(w, K.Bet, '45.00', 'bet-2');
    const rb = wager(K.Rollback, '50.00', { referenceExternalTransactionId: 'win-1' });
    const out = settle(w, rb, win);
    expect(out.status).toBe(S.Rejected);
    expect(rb.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(w.balance.amount).toBe('5.00');
  });
});

describe('referência fora de ordem', () => {
  test('referência ausente: PENDING_REFERENCE + evento, sem mexer no saldo', () => {
    const w = wallet('100.00');
    const rb = wager(K.Rollback, '10.00', { referenceExternalTransactionId: 'bet-late' });
    const out = settle(w, rb, undefined);
    expect(out.status).toBe(S.PendingReference);
    expect(rb.nextAttemptAt).toEqual(new Date(NOW.getTime() + 1_000));
    expect(types(out)).toEqual(['WagerTransactionPendingReference']);
    expect(w.version).toBe(1);
  });

  test('referência chega depois: aplica normalmente', () => {
    const w = wallet('100.00');
    const refund = wager(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-late' });
    settle(w, refund, undefined);
    const bet = processed(w, K.Bet, '10.00', 'bet-late');
    settle(w, refund, bet);
    expect(refund.status).toBe(S.Processed);
    expect(w.balance.amount).toBe('100.00');
  });

  test('backoff exponencial e REJECTED REFERENCE_NOT_FOUND ao esgotar', () => {
    const w = wallet('100.00');
    const tx = wager(K.Refund, '10.00', { referenceExternalTransactionId: 'never' });
    settle(w, tx); // primeira vez: +1s
    settle(w, tx); // retry 1: +2s
    expect(tx.nextAttemptAt).toEqual(new Date(NOW.getTime() + 2_000));
    expect(tx.attempts).toBe(1);
    settle(w, tx); // retry 2: +4s
    const last = settle(w, tx); // retry 3 = maxAttempts
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(types(last)).toEqual(['WagerTransactionRejected']);
  });
});

describe('conflitos de wallet e moeda', () => {
  test('moeda diferente da wallet: CURRENCY_MISMATCH', () => {
    const w = wallet('100.00');
    const tx = wager(K.Bet, usd('1.00'));
    settle(w, tx);
    expect(tx.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(w.balance.amount).toBe('100.00');
  });

  test('wallet de outro player: WALLET_PLAYER_MISMATCH', () => {
    const w = Wallet.open({
      id: WALLET, playerId: 'outro', initialBalance: brl('100.00'), openingTransactionId: 'o', at: NOW,
    }).wallet;
    const tx = wager(K.Bet, '1.00', { playerId: PLAYER });
    settle(w, tx);
    expect(tx.failureCode).toBe(FailureCode.WalletPlayerMismatch);
  });
});

describe('eventos', () => {
  test('WalletBalanceChanged carrega MoneyProps (string), não a instância de Money', () => {
    const w = wallet('100.00');
    const out = settle(w, wager(K.Bet, '25.00'));
    const changed = out.events.find((e) => e.eventType === 'WalletBalanceChanged')!.toJSON();
    expect(changed.version).toBe(1);
    expect(changed.correlationId).toBe('corr-1');
    expect(changed.occurredAt).toBe(NOW.toISOString());
    expect(changed.data).toMatchObject({
      walletId: WALLET,
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
    const json = JSON.parse(JSON.stringify(changed));
    expect(json.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(Object.values(json.data).some((v) => v instanceof Money)).toBe(false);
  });
});
