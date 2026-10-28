import { describe, expect, test } from 'bun:test';
import { WagerTransactionRejected } from '../../src/domain/events/wagering-events';
import { FailureCode } from '../../src/domain/failure-code';
import { InboxMessage } from '../../src/domain/inbox-message';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { ExponentialBackoff } from '../../src/domain/retry-policy';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { CTX, NOW, wager } from '../support/builders';

const later = (ms: number) => new Date(NOW.getTime() + ms);

describe('InboxMessage', () => {
  test('marca processada uma única vez', () => {
    const m = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'h', receivedAt: NOW });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(NOW);
    expect(m.isProcessed()).toBe(true);
    expect(() => m.markProcessed(NOW)).toThrow();
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const tx = wager(WagerTransactionKind.Bet);
    tx.reject(FailureCode.InsufficientFunds, NOW);
    return WagerTransactionRejected.from(tx, CTX);
  };

  test('enqueue usa o eventId como id e grava o envelope serializado', () => {
    const e = event();
    const m = OutboxMessage.enqueue(e);
    expect(m.id).toBe(e.eventId);
    expect(m.eventType).toBe('WagerTransactionRejected');
    expect(m.payload).toMatchObject({ eventId: e.eventId, eventType: 'WagerTransactionRejected', version: 1 });
    expect(m.isPending()).toBe(true);
    expect(m.isDue(NOW)).toBe(true);
  });

  test('scheduleRetry aplica backoff exponencial com teto', () => {
    const m = OutboxMessage.enqueue(event());
    const policy = new ExponentialBackoff(1_000, 4_000, 100);
    m.scheduleRetry(NOW, policy);
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt).toEqual(later(1_000));
    expect(m.isDue(later(999))).toBe(false);
    m.scheduleRetry(NOW, policy);
    expect(m.nextAttemptAt).toEqual(later(2_000));
    m.scheduleRetry(NOW, policy);
    m.scheduleRetry(NOW, policy);
    expect(m.nextAttemptAt).toEqual(later(4_000));
  });

  test('publicada não volta a pendente nem reagenda', () => {
    const m = OutboxMessage.enqueue(event());
    m.markPublished(NOW);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(later(1))).toBe(false);
    expect(() => m.markPublished(NOW)).toThrow();
    expect(() => m.scheduleRetry(NOW)).toThrow();
  });
});
