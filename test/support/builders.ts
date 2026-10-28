import { Money } from '../../src/domain/money';
import { ExponentialBackoff } from '../../src/domain/retry-policy';
import { Wallet } from '../../src/domain/wallet';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wager-transaction';
import { wagerPayloadHash } from '../../src/domain/payload-hash';

export const NOW = new Date('2026-10-28T12:00:00.000Z');
export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

export function wallet(balance = '100.00', overrides: Partial<{ id: string; playerId: string }> = {}): Wallet {
  return Wallet.open({
    id: overrides.id ?? WALLET,
    playerId: overrides.playerId ?? PLAYER,
    initialBalance: brl(balance),
    openingTransactionId: crypto.randomUUID(),
    at: NOW,
  }).wallet;
}

let seq = 0;
export function wager(
  kind: WagerTransactionKind,
  amount: string | Money = '10.00',
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${++seq}`;
  const money = typeof amount === 'string' ? brl(amount) : amount;
  const fields = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: PLAYER,
    walletId: WALLET,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money,
    ...overrides,
  };
  return WagerTransaction.create({
    idempotencyKey: `${fields.providerId}:${externalTransactionId}`,
    payloadHash: wagerPayloadHash(fields),
    createdAt: NOW,
    ...fields,
  });
}

export const RETRY = new ExponentialBackoff(1_000, 8_000, 3);
export const CTX = { correlationId: 'corr-1', occurredAt: NOW };
