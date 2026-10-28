import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { type SubmitWagerCommand, parseSubmitWager } from '../../src/application/commands';
import { ConflictError, NotFoundError, ValidationError } from '../../src/application/errors';
import type { WageringStore, WageringUnitOfWork } from '../../src/application/ports';
import { WageringQueries } from '../../src/application/wagering-queries';
import { WageringService } from '../../src/application/wagering.service';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { ExponentialBackoff } from '../../src/domain/retry-policy';
import { WagerTransactionStatus as S } from '../../src/domain/wager-transaction';
import { MikroOrmWageringStore } from '../../src/infrastructure/persistence/mikro-orm-wagering.store';
import { createTestOrm, uuid } from '../support/database';
import { count, expectLedgerConsistent } from '../support/invariants';

let orm: MikroORM;
let store: MikroOrmWageringStore;
let service: WageringService;
let queries: WageringQueries;

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

beforeAll(async () => {
  orm = await createTestOrm();
  store = new MikroOrmWageringStore(orm);
  service = new WageringService(store, { referenceRetry: new ExponentialBackoff(1_000, 8_000, 3) });
  queries = new WageringQueries(store);
});

afterAll(async () => {
  await expectLedgerConsistent(orm);
  await orm.close(true);
});

async function newWallet(balance = '100.00') {
  const playerId = uuid();
  const wallet = await service.createWallet({ playerId, initialBalance: brl(balance), correlationId: 'c' });
  return { walletId: wallet.id, playerId };
}

function cmd(
  w: { walletId: string; playerId: string },
  body: Record<string, unknown> = {},
  key?: string,
): SubmitWagerCommand {
  const externalTransactionId = (body.externalTransactionId as string) ?? `tx-${uuid()}`;
  return parseSubmitWager(
    {
      providerId: 'provider-a',
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...body,
      externalTransactionId,
    },
    { idempotencyKey: key ?? `provider-a:${externalTransactionId}`, correlationId: 'corr' },
  );
}

describe('criação de wallet', () => {
  test('saldo inicial gera OPENING + CREDIT + evento, na mesma transação', async () => {
    const { walletId } = await newWallet('1000.00');
    const wallet = await queries.wallet(walletId);
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(await count(orm, `select 1 from wager_transactions where wallet_id = ? and kind = 'OPENING'`, [walletId])).toBe(1);
    expect(await count(orm, `select 1 from wallet_ledger_entries where wallet_id = ?`, [walletId])).toBe(1);
    expect(await count(orm, `select 1 from outbox_messages where aggregate_id = ? and event_type = 'WalletBalanceChanged'`, [walletId])).toBe(1);
  });

  test('saldo inicial zero não gera ledger', async () => {
    const { walletId } = await newWallet('0');
    expect(await count(orm, `select 1 from wallet_ledger_entries where wallet_id = ?`, [walletId])).toBe(0);
  });

  test('wallet duplicada para player + moeda é conflito', async () => {
    const { playerId } = await newWallet();
    const attempt = service.createWallet({ playerId, initialBalance: brl('5.00'), correlationId: 'c' });
    expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await attempt.catch(() => {});
  });
});

describe('submissão', () => {
  test('BET processada: saldo, ledger e eventos', async () => {
    const w = await newWallet('100.00');
    const r = await service.submit(cmd(w, { money: { amount: '25.00', currency: 'BRL' } }));
    expect(r.idempotentReplay).toBe(false);
    expect(r.transaction.status).toBe(S.Processed);
    expect(r.transaction.observedBalance?.amount).toBe('75.00');
    const wallet = await queries.wallet(w.walletId);
    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(await count(orm, `select 1 from outbox_messages where payload->'data'->>'transactionId' = ?`, [r.transaction.id])).toBe(2);
  });

  test('replay devolve o resultado original, inclusive o saldo daquele momento', async () => {
    const w = await newWallet('100.00');
    const first = await service.submit(cmd(w, { externalTransactionId: 'bet-replay' }));
    await service.submit(cmd(w, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } }));
    const replay = await service.submit(cmd(w, { externalTransactionId: 'bet-replay' }));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.transaction.observedBalance?.amount).toBe('90.00');
    expect((await queries.wallet(w.walletId)).balance.amount).toBe('140.00');
    expect(await count(orm, `select 1 from wallet_ledger_entries where transaction_id = ?`, [first.transaction.id])).toBe(1);
  });

  test('replay de rejeição devolve a mesma rejeição', async () => {
    const w = await newWallet('5.00');
    const a = await service.submit(cmd(w, { externalTransactionId: 'poor' }));
    const b = await service.submit(cmd(w, { externalTransactionId: 'poor' }));
    expect(a.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(b.idempotentReplay).toBe(true);
    expect(b.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('mesma key com payload diferente é conflito, não replay', async () => {
    const w = await newWallet();
    await service.submit(cmd(w, { externalTransactionId: 'k-1' }));
    const attempt = service.submit(cmd(w, { externalTransactionId: 'k-1', money: { amount: '11.00', currency: 'BRL' } }));
    expect(attempt).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await attempt.catch(() => {});
  });

  test('mesmo externalTransactionId sob outra key é conflito', async () => {
    const w = await newWallet();
    await service.submit(cmd(w, { externalTransactionId: 'k-2' }));
    const attempt = service.submit(cmd(w, { externalTransactionId: 'k-2' }, 'outra-key'));
    expect(attempt).rejects.toMatchObject({ code: 'EXTERNAL_TRANSACTION_ID_REUSED' });
    await attempt.catch(() => {});
  });

  test('wallet inexistente é 404 e nada é gravado', async () => {
    const attempt = service.submit(cmd({ walletId: uuid(), playerId: uuid() }, { externalTransactionId: 'ghost' }));
    expect(attempt).rejects.toBeInstanceOf(NotFoundError);
    await attempt.catch(() => {});
    expect(await count(orm, `select 1 from wager_transactions where external_transaction_id = 'ghost'`)).toBe(0);
  });

  test('regra de formato do domínio vira ValidationError', async () => {
    const w = await newWallet();
    expect(() => cmd(w, { kind: 'OPENING' })).toThrow(ValidationError);
    const attempt = service.submit(cmd(w, { kind: 'REFUND' }));
    expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await attempt.catch(() => {});
  });
});

describe('reversões e referências fora de ordem', () => {
  test('REFUND antes da BET: pendente; BET chega e acorda o REFUND; worker aplica', async () => {
    const w = await newWallet('100.00');
    const refund = await service.submit(
      cmd(w, { kind: 'REFUND', externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-late' }),
    );
    expect(refund.transaction.status).toBe(S.PendingReference);

    await service.submit(cmd(w, { externalTransactionId: 'bet-late' }));
    // A BET antecipa a próxima tentativa do REFUND para "agora".
    const due = await store.claimDuePendingReferences(new Date(), 10, 30_000);
    expect(due.map((d) => d.transactionId)).toContain(refund.transaction.id);

    expect(await service.retryPendingReference({ transactionId: refund.transaction.id, walletId: w.walletId })).toBe('processed');
    const tx = await queries.transaction(refund.transaction.id);
    expect(tx.status).toBe(S.Processed);
    expect((await queries.wallet(w.walletId)).balance.amount).toBe('100.00');
  });

  test('segunda reversão da mesma BET é rejeitada', async () => {
    const w = await newWallet('100.00');
    await service.submit(cmd(w, { externalTransactionId: 'bet-2' }));
    await service.submit(cmd(w, { kind: 'REFUND', externalTransactionId: 'rf-2', referenceExternalTransactionId: 'bet-2' }));
    const rb = await service.submit(cmd(w, { kind: 'ROLLBACK', externalTransactionId: 'rb-2', referenceExternalTransactionId: 'bet-2' }));
    expect(rb.transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect((await queries.wallet(w.walletId)).balance.amount).toBe('100.00');
  });

  test('referência nunca chega: REJECTED REFERENCE_NOT_FOUND após o limite', async () => {
    const w = await newWallet('100.00');
    const r = await service.submit(cmd(w, { kind: 'ROLLBACK', externalTransactionId: 'rb-x', referenceExternalTransactionId: 'nunca' }));
    const candidate = { transactionId: r.transaction.id, walletId: w.walletId };
    expect(await service.retryPendingReference(candidate)).toBe('rescheduled');
    expect(await service.retryPendingReference(candidate)).toBe('rescheduled');
    expect(await service.retryPendingReference(candidate)).toBe('rejected');
    expect(await service.retryPendingReference(candidate)).toBe('skipped');
    expect((await queries.transaction(r.transaction.id)).failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(await count(orm, `select 1 from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionRejected'`, [r.transaction.id])).toBe(1);
  });
});

describe('atomicidade', () => {
  test('falha ao gravar a outbox desfaz transação, ledger e saldo', async () => {
    const w = await newWallet('100.00');
    const failingStore: WageringStore = Object.create(store);
    failingStore.transaction = (fn) =>
      store.transaction((uow) =>
        fn(
          new Proxy(uow, {
            get(target, prop, receiver) {
              if (prop === 'enqueue') return async () => { throw new Error('outbox down'); };
              return Reflect.get(target, prop, receiver);
            },
          }) as WageringUnitOfWork,
        ),
      );
    const failing = new WageringService(failingStore);
    const attempt = failing.submit(cmd(w, { externalTransactionId: 'atomic-1' }));
    expect(attempt).rejects.toThrow('outbox down');
    await attempt.catch(() => {});

    expect(await count(orm, `select 1 from wager_transactions where external_transaction_id = 'atomic-1'`)).toBe(0);
    const wallet = await queries.wallet(w.walletId);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(await count(orm, `select 1 from wallet_ledger_entries where wallet_id = ?`, [w.walletId])).toBe(1);
  });

  test('inbox: mesma mensagem duas vezes não duplica efeito', async () => {
    const w = await newWallet('100.00');
    const inbox = { consumerName: 'wager-consumer', messageId: `msg-${uuid()}`, payloadHash: 'h'.repeat(64) };
    const c = { ...cmd(w, { externalTransactionId: 'via-sqs' }), inbox };
    const first = await service.submit(c);
    const second = await service.submit(c);
    expect(second.idempotentReplay).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(await count(orm, `select 1 from inbox_messages where message_id = ?`, [inbox.messageId])).toBe(1);
    expect((await queries.wallet(w.walletId)).balance.amount).toBe('90.00');
  });
});

describe('consultas', () => {
  test('ledger paginado com cursor estável', async () => {
    const w = await newWallet('100.00');
    for (let i = 0; i < 5; i++) await service.submit(cmd(w, { money: { amount: '1.00', currency: 'BRL' } }));
    const p1 = await queries.ledger(w.walletId, undefined, 4);
    expect(p1.entries).toHaveLength(4);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await queries.ledger(w.walletId, p1.nextCursor, 4);
    expect(p2.entries).toHaveLength(2);
    expect(p2.nextCursor).toBeUndefined();
    expect(p2.entries.at(-1)?.balanceAfter.amount).toBe('95.00');
    expect(queries.ledger(w.walletId, 'lixo', 4)).rejects.toBeInstanceOf(ValidationError);
  });

  test('reconciliação consistente', async () => {
    const w = await newWallet('100.00');
    await service.submit(cmd(w, { money: { amount: '30.00', currency: 'BRL' } }));
    const report = await queries.reconcile(w.walletId, 'c');
    expect(report.consistent).toBe(true);
    expect(report.storedBalance.amount).toBe('70.00');
    expect(report.difference.amount).toBe('0.00');
    expect(report.checkedEntries).toBe(2);
  });
});
