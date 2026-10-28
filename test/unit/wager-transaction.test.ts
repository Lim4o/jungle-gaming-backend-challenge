import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { wagerPayloadHash } from '../../src/domain/payload-hash';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wager-transaction';
import { NOW, brl, usd, wager } from '../support/builders';

describe('WagerTransaction.create', () => {
  test('nasce PENDING', () => {
    expect(wager(K.Bet).status).toBe(S.Pending);
  });

  test('OPENING não pode ser submetido', () => {
    expect(() => wager(K.Opening)).toThrow(InvalidWagerTransactionError);
  });

  test('provider "internal" é reservado', () => {
    expect(() => wager(K.Bet, '1.00', { providerId: 'internal' })).toThrow(InvalidWagerTransactionError);
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    expect(() => wager(K.Refund)).toThrow(InvalidWagerTransactionError);
    expect(() => wager(K.Rollback)).toThrow(InvalidWagerTransactionError);
    expect(wager(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('BET não pode ter referência; WIN e LOSS podem', () => {
    expect(() => wager(K.Bet, '1.00', { referenceExternalTransactionId: 'x' })).toThrow(InvalidWagerTransactionError);
    expect(wager(K.Win, '1.00', { referenceExternalTransactionId: 'x' }).referenceExternalTransactionId).toBe('x');
    expect(wager(K.Loss, '0', { referenceExternalTransactionId: 'x' }).affectsBalance()).toBe(false);
  });

  test('não referencia a si mesma', () => {
    expect(() =>
      wager(K.Refund, '1.00', { externalTransactionId: 'same', referenceExternalTransactionId: 'same' }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('valor zero só em LOSS', () => {
    expect(() => wager(K.Bet, '0')).toThrow(InvalidWagerTransactionError);
    expect(() => wager(K.Win, '0')).toThrow(InvalidWagerTransactionError);
    expect(wager(K.Loss, '0').money.isZero()).toBe(true);
  });

  test('campos obrigatórios', () => {
    expect(() => wager(K.Bet, '1.00', { roundId: ' ' })).toThrow(InvalidWagerTransactionError);
  });
});

describe('transições de estado', () => {
  test('PENDING -> PROCESSED é terminal', () => {
    const tx = wager(K.Bet);
    tx.markProcessed(undefined, NOW, brl('90.00'));
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toEqual(NOW);
    expect(() => tx.reject(FailureCode.InsufficientFunds, NOW)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed(undefined, NOW, brl('1'))).toThrow(InvalidTransactionStateError);
  });

  test('REJECTED e FAILED são terminais', () => {
    const r = wager(K.Bet);
    r.reject(FailureCode.InsufficientFunds, NOW);
    expect(r.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => r.fail(FailureCode.PermanentProcessingError, NOW)).toThrow(InvalidTransactionStateError);

    const f = wager(K.Bet);
    f.fail(FailureCode.PermanentProcessingError, NOW);
    expect(f.isTerminal()).toBe(true);
    expect(() => f.markProcessed(undefined, NOW, brl('1'))).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE pode ser reagendado, e o contador sobe a cada retry', () => {
    const tx = wager(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-x' });
    tx.markPendingReference(new Date(NOW.getTime() + 1000), NOW);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.attempts).toBe(0);
    tx.markPendingReference(new Date(NOW.getTime() + 2000), NOW);
    expect(tx.attempts).toBe(1);
    expect(tx.isTerminal()).toBe(false);
  });

  test('PENDING_REFERENCE exige referência no payload', () => {
    expect(() => wager(K.Bet).markPendingReference(NOW, NOW)).toThrow(InvalidWagerTransactionError);
  });

  test('reversão não é processada sem referência resolvida', () => {
    const tx = wager(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-x' });
    expect(() => tx.markProcessed(undefined, NOW, brl('1'))).toThrow(InvalidWagerTransactionError);
  });

  test('OPENING nasce processado', () => {
    const tx = WagerTransaction.opening({
      id: 'o', walletId: 'w', playerId: 'p', money: brl('10'), payloadHash: 'h', at: NOW,
    });
    expect(tx.kind).toBe(K.Opening);
    expect(tx.status).toBe(S.Processed);
  });
});

describe('direção no ledger', () => {
  test('BET debita; WIN e REFUND creditam', () => {
    expect(wager(K.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(wager(K.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(wager(K.Refund, '1', { referenceExternalTransactionId: 'b' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK inverte a referência', () => {
    const rb = wager(K.Rollback, '1', { referenceExternalTransactionId: 'b' });
    expect(rb.ledgerDirectionFor(wager(K.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(wager(K.Win))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(wager(K.Refund, '1', { referenceExternalTransactionId: 'b' }))).toBe(LedgerDirection.Debit);
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test('LOSS não tem direção', () => {
    expect(() => wager(K.Loss).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test('falta de saldo em aposta e em reversão têm códigos distintos', () => {
    expect(wager(K.Bet).insufficientFundsCode()).toBe(FailureCode.InsufficientFunds);
    expect(wager(K.Rollback, '1', { referenceExternalTransactionId: 'w' }).insufficientFundsCode()).toBe(
      FailureCode.ReversalInsufficientFunds,
    );
  });
});

describe('checkReference', () => {
  const processedBet = (overrides = {}) => {
    const bet = wager(K.Bet, '10.00', { externalTransactionId: 'bet-1', ...overrides });
    bet.markProcessed(undefined, NOW, brl('90.00'));
    return bet;
  };
  const refund = (amount = '10.00', overrides = {}) =>
    wager(K.Refund, amount, { referenceExternalTransactionId: 'bet-1', ...overrides });

  test('referência válida', () => {
    expect(refund().checkReference(processedBet())).toBeUndefined();
  });

  test('outra rodada, player, wallet ou provider -> REFERENCE_MISMATCH', () => {
    for (const o of [{ roundId: 'r2' }, { playerId: 'p2' }, { walletId: 'w2' }, { providerId: 'provider-b' }]) {
      expect(refund().checkReference(processedBet(o))).toBe(FailureCode.ReferenceMismatch);
    }
  });

  test('outra moeda -> REFERENCE_MISMATCH', () => {
    expect(refund('10.00', { money: usd('10.00') }).checkReference(processedBet())).toBe(FailureCode.ReferenceMismatch);
  });

  test('REFUND só referencia BET', () => {
    const win = wager(K.Win, '10.00', { externalTransactionId: 'bet-1' });
    win.markProcessed(undefined, NOW, brl('110'));
    expect(refund().checkReference(win)).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('ROLLBACK não referencia LOSS', () => {
    const loss = wager(K.Loss, '10.00', { externalTransactionId: 'bet-1' });
    loss.markProcessed(undefined, NOW, brl('100'));
    const rb = wager(K.Rollback, '10.00', { referenceExternalTransactionId: 'bet-1' });
    expect(rb.checkReference(loss)).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('referência rejeitada -> REFERENCE_NOT_PROCESSED', () => {
    const bet = wager(K.Bet, '10.00', { externalTransactionId: 'bet-1' });
    bet.reject(FailureCode.InsufficientFunds, NOW);
    expect(refund().checkReference(bet)).toBe(FailureCode.ReferenceNotProcessed);
  });

  test('valor diferente -> REFERENCE_AMOUNT_MISMATCH (sem reversão parcial)', () => {
    expect(refund('5.00').checkReference(processedBet())).toBe(FailureCode.ReferenceAmountMismatch);
  });
});

describe('idempotência: payloadHash', () => {
  const fields = {
    providerId: 'provider-a', externalTransactionId: 't-1', playerId: 'p', walletId: 'w',
    roundId: 'r', gameId: 'g', kind: 'BET', money: brl('25.00'),
  };

  test('mesmo payload, mesmo hash (independe de ordem de chaves e escala)', () => {
    const reordered = { money: brl('25'), kind: 'BET', gameId: 'g', roundId: 'r', walletId: 'w', playerId: 'p', externalTransactionId: 't-1', providerId: 'provider-a' };
    expect(wagerPayloadHash(fields)).toBe(wagerPayloadHash(reordered));
    expect(wagerPayloadHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('mesma idempotency key com payload divergente não casa', () => {
    const original = wager(K.Bet, '25.00', { externalTransactionId: 'same' });
    const divergentHash = wagerPayloadHash({ ...fields, externalTransactionId: 'same', money: brl('26.00') });
    expect(original.matchesPayload(divergentHash)).toBe(false);
    expect(original.matchesPayload(original.payloadHash)).toBe(true);
  });

  test('qualquer campo de negócio muda o hash', () => {
    const base = wagerPayloadHash(fields);
    for (const change of [{ roundId: 'x' }, { gameId: 'x' }, { kind: 'WIN' }, { money: usd('25.00') }, { referenceExternalTransactionId: 'x' }]) {
      expect(wagerPayloadHash({ ...fields, ...change })).not.toBe(base);
    }
  });
});
