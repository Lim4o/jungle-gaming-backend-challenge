/**
 * Paralelismo real: cada submit roda numa conexão própria do pool, então as
 * transações disputam o lock da wallet dentro do PostgreSQL ao mesmo tempo.
 * Nada aqui é mock sequencial.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { parseSubmitWager } from '../../src/application/commands';
import { WageringService } from '../../src/application/wagering.service';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { WagerTransactionStatus as S } from '../../src/domain/wager-transaction';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmWageringStore } from '../../src/infrastructure/persistence/mikro-orm-wagering.store';
import { TEST_DATABASE_URL, createTestOrm, uuid } from '../support/database';
import { count, expectLedgerConsistent } from '../support/invariants';

let orm: MikroORM;
let service: WageringService;

beforeAll(async () => {
  const migrated = await createTestOrm();
  await migrated.close(true);
  // Pool grande para que as requisições realmente rodem em paralelo no banco.
  orm = await MikroORM.init({ ...buildOrmConfig({ clientUrl: TEST_DATABASE_URL }), pool: { min: 0, max: 60 } });
  service = new WageringService(new MikroOrmWageringStore(orm, { lockTimeoutMs: 30_000 }));
});

afterAll(async () => {
  await expectLedgerConsistent(orm);
  await orm.close(true);
});

async function newWallet(balance: string) {
  const playerId = uuid();
  const w = await service.createWallet({
    playerId,
    initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
    correlationId: 'c',
  });
  return { walletId: w.id, playerId };
}

function bet(w: { walletId: string; playerId: string }, amount: string, externalTransactionId = `tx-${uuid()}`, kind = 'BET') {
  return parseSubmitWager(
    {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'r',
      gameId: 'g',
      kind,
      money: { amount, currency: 'BRL' },
    },
    { idempotencyKey: `provider-a:${externalTransactionId}`, correlationId: 'c' },
  );
}

const balanceOf = async (walletId: string) =>
  (await orm.em.fork().execute<{ b: string }[]>(`select balance::text as b from wallets where id = ?`, [walletId]))[0]!.b;

describe('concorrência na mesma wallet', () => {
  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const w = await newWallet('100.00');
    const same = bet(w, '10.00', 'same-bet');
    const results = await Promise.all(Array.from({ length: 50 }, () => service.submit(same)));

    const ids = new Set(results.map((r) => r.transaction.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.transaction.observedBalance?.amount === '90.00')).toBe(true);
    expect(await balanceOf(w.walletId)).toBe('90.00');
    expect(await count(orm, `select 1 from wallet_ledger_entries where transaction_id = ?`, [[...ids][0]])).toBe(1);
  });

  test('cenário obrigatório: 100.00 e duas apostas de 80.00 simultâneas (repetido 25x)', async () => {
    for (let round = 0; round < 25; round++) {
      const w = await newWallet('100.00');
      const [a, b] = await Promise.all([service.submit(bet(w, '80.00')), service.submit(bet(w, '80.00'))]);
      const statuses = [a.transaction.status, b.transaction.status].sort();
      expect(statuses).toEqual([S.Processed, S.Rejected].sort());
      const rejected = [a, b].find((r) => r.transaction.status === S.Rejected)!;
      expect(rejected.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(await balanceOf(w.walletId)).toBe('20.00');
      expect(await count(orm, `select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.walletId])).toBe(1);

      // Retry das duas: nenhum débito novo.
      await Promise.all([service.submit(bet(w, '80.00', a.transaction.externalTransactionId)), service.submit(bet(w, '80.00', b.transaction.externalTransactionId))]);
      expect(await balanceOf(w.walletId)).toBe('20.00');
    }
  });

  test('hot wallet: 200 operações misturadas em paralelo nunca deixam saldo negativo', async () => {
    const w = await newWallet('50.00');
    const ops = Array.from({ length: 200 }, (_, i) =>
      i % 3 === 0 ? bet(w, '7.00', undefined, 'WIN') : bet(w, '5.00'),
    );
    const results = await Promise.all(ops.map((c) => service.submit(c)));
    const processed = results.filter((r) => r.transaction.status === S.Processed);
    const wins = processed.filter((r) => r.transaction.kind === 'WIN').length;
    const bets = processed.filter((r) => r.transaction.kind === 'BET').length;

    const expected = Money.from({ amount: '50.00', currency: 'BRL' });
    const final = Array.from({ length: wins }).reduce<Money>((m) => m.add(Money.from({ amount: '7.00', currency: 'BRL' })), expected);
    const afterBets = Array.from({ length: bets }).reduce<Money>((m) => m.subtract(Money.from({ amount: '5.00', currency: 'BRL' })), final);
    expect(await balanceOf(w.walletId)).toBe(afterBets.amount);
    expect(afterBets.isNegative()).toBe(false);
    expect(results.every((r) => r.transaction.status !== S.Rejected || r.transaction.failureCode === FailureCode.InsufficientFunds)).toBe(true);
  });
});

describe('wallets distintas', () => {
  test('30 wallets processadas em paralelo, 10 apostas cada, sem interferência', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, () => newWallet('100.00')));
    const started = performance.now();
    await Promise.all(wallets.flatMap((w) => Array.from({ length: 10 }, () => service.submit(bet(w, '3.00')))));
    const elapsed = performance.now() - started;

    for (const w of wallets) expect(await balanceOf(w.walletId)).toBe('70.00');
    console.log(`300 apostas em 30 wallets em ${elapsed.toFixed(0)} ms`);
  });
});
