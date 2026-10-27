/**
 * Prova que as garantias de unicidade, imutabilidade, não-negatividade e
 * consistência saldo↔ledger estão no SCHEMA (seção 5, item 9): os comandos
 * abaixo usam SQL cru, sem passar por nenhuma regra da aplicação.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, expectSqlState, uuid } from '../support/database';

const UNIQUE = '23505';
const CHECK = '23514';

let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
});

afterAll(async () => {
  await orm.close(true);
});

const tx = <T>(fn: (em: EntityManager) => Promise<T>) => orm.em.fork().transactional(fn);
const now = new Date();

/** Wallet aberta corretamente: wallet + transação OPENING + lançamento CREDIT. */
async function openWallet(balance = '100.00') {
  const walletId = uuid();
  const playerId = uuid();
  const openingId = uuid();
  await tx(async (em) => {
    await em.execute(
      `insert into wallets values (?, ?, 'BRL', ?, 1, ?, ?)`,
      [walletId, playerId, balance, now, now],
    );
    await em.execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key,
         payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
         balance_after, created_at, updated_at, processed_at)
       values (?, 'internal', ?, ?, ?, ?, ?, 'opening', 'opening', 'OPENING', ?, 'BRL',
               'PROCESSED', ?, ?, ?, ?)`,
      [openingId, openingId, `internal:${openingId}`, 'a'.repeat(64), walletId, playerId,
       balance, balance, now, now, now],
    );
    await em.execute(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, 'CREDIT', ?, 'BRL', 0, ?, ?)`,
      [uuid(), walletId, openingId, balance, balance, now],
    );
  });
  return { walletId, playerId, openingId };
}

async function insertTx(
  em: EntityManager,
  w: { walletId: string; playerId: string },
  fields: Partial<Record<'id' | 'kind' | 'amount' | 'status' | 'externalId' | 'key' | 'refExternal' | 'refId' | 'failureCode' | 'balanceAfter', string | null>> = {},
) {
  const id = fields.id ?? uuid();
  const ext = fields.externalId ?? uuid();
  const status = fields.status ?? 'PENDING';
  await em.execute(
    `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key,
       payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency,
       reference_external_transaction_id, reference_transaction_id, status, failure_code,
       balance_after, created_at, updated_at, processed_at)
     values (?, 'provider-a', ?, ?, ?, ?, ?, 'round-1', 'game-1', ?, ?, 'BRL', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, ext, fields.key ?? `provider-a:${ext}`, 'b'.repeat(64), w.walletId, w.playerId,
      fields.kind ?? 'BET', fields.amount ?? '10.00', fields.refExternal ?? null, fields.refId ?? null,
      status, fields.failureCode ?? null, fields.balanceAfter ?? null, now, now,
      status === 'PROCESSED' ? now : null,
    ],
  );
  return id;
}

describe('wallets', () => {
  test('abertura válida (wallet + OPENING + ledger) confirma', async () => {
    const { walletId } = await openWallet('100.00');
    const [row] = await orm.em.fork().execute(`select balance, version from wallets where id = ?`, [walletId]);
    expect(row).toEqual({ balance: '100.00', version: 1 });
  });

  test('no máximo uma wallet por player + moeda', async () => {
    const playerId = uuid();
    await tx((em) => em.execute(`insert into wallets values (?, ?, 'BRL', 0, 1, ?, ?)`, [uuid(), playerId, now, now]));
    await expectSqlState(
      () => tx((em) => em.execute(`insert into wallets values (?, ?, 'BRL', 0, 1, ?, ?)`, [uuid(), playerId, now, now])),
      UNIQUE,
    );
    // Outra moeda para o mesmo player é permitida.
    await tx((em) => em.execute(`insert into wallets values (?, ?, 'USD', 0, 1, ?, ?)`, [uuid(), playerId, now, now]));
  });

  test('saldo negativo é rejeitado pelo banco', async () => {
    await expectSqlState(
      () => tx((em) => em.execute(`insert into wallets values (?, ?, 'BRL', -0.01, 1, ?, ?)`, [uuid(), uuid(), now, now])),
      CHECK,
    );
  });

  test('alterar saldo sem lançamento no ledger falha no commit', async () => {
    const { walletId } = await openWallet('100.00');
    await expectSqlState(
      () => tx((em) => em.execute(`update wallets set balance = 50, version = 2 where id = ?`, [walletId])),
      'WG009',
    );
  });

  test('version deve incrementar exatamente 1 quando o saldo muda', async () => {
    const { walletId } = await openWallet('100.00');
    await expectSqlState(
      () => tx((em) => em.execute(`update wallets set balance = 50, version = 5 where id = ?`, [walletId])),
      'WG002',
    );
    await expectSqlState(
      () => tx((em) => em.execute(`update wallets set version = 2 where id = ?`, [walletId])),
      'WG002',
    );
  });

  test('wallet não pode ser excluída', async () => {
    const { walletId } = await openWallet();
    await expectSqlState(() => tx((em) => em.execute(`delete from wallets where id = ?`, [walletId])), 'WG003');
  });
});

describe('ledger', () => {
  test('débito válido: saldo e ledger andam juntos', async () => {
    const w = await openWallet('100.00');
    await tx(async (em) => {
      const betId = await insertTx(em, w, { amount: '30.00' });
      await em.execute(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (?, ?, ?, 'DEBIT', 30, 'BRL', 100, 70, ?)`,
        [uuid(), w.walletId, betId, now],
      );
      await em.execute(`update wallets set balance = 70, version = 2 where id = ?`, [w.walletId]);
    });
  });

  test('aritmética do lançamento é verificada', async () => {
    const w = await openWallet('100.00');
    await expectSqlState(
      () =>
        tx(async (em) => {
          const betId = await insertTx(em, w);
          await em.execute(
            `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
             values (?, ?, ?, 'DEBIT', 10, 'BRL', 100, 95, ?)`,
            [uuid(), w.walletId, betId, now],
          );
        }),
      CHECK,
    );
  });

  test('lançamento precisa partir do saldo do lançamento anterior', async () => {
    const w = await openWallet('100.00');
    await expectSqlState(
      () =>
        tx(async (em) => {
          const betId = await insertTx(em, w);
          await em.execute(
            `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
             values (?, ?, ?, 'DEBIT', 10, 'BRL', 500, 490, ?)`,
            [uuid(), w.walletId, betId, now],
          );
        }),
      'WG008',
    );
  });

  test('no máximo um lançamento por transação e wallet', async () => {
    const w = await openWallet('100.00');
    await expectSqlState(
      () =>
        tx(async (em) => {
          await em.execute(
            `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
             values (?, ?, ?, 'CREDIT', 10, 'BRL', 100, 110, ?)`,
            [uuid(), w.walletId, w.openingId, now],
          );
        }),
      UNIQUE,
    );
  });

  test('ledger é append-only: UPDATE, DELETE e TRUNCATE falham', async () => {
    const w = await openWallet();
    await expectSqlState(
      () => tx((em) => em.execute(`update wallet_ledger_entries set amount = 1 where wallet_id = ?`, [w.walletId])),
      'WG006',
    );
    await expectSqlState(
      () => tx((em) => em.execute(`delete from wallet_ledger_entries where wallet_id = ?`, [w.walletId])),
      'WG006',
    );
    await expectSqlState(() => tx((em) => em.execute(`truncate wallet_ledger_entries cascade`)), 'WG006');
  });
});

describe('wager_transactions', () => {
  test('idempotency key é única', async () => {
    const w = await openWallet();
    await tx((em) => insertTx(em, w, { key: 'dup-key' }));
    await expectSqlState(() => tx((em) => insertTx(em, w, { key: 'dup-key' })), UNIQUE);
  });

  test('(providerId, externalTransactionId) é único', async () => {
    const w = await openWallet();
    await tx((em) => insertTx(em, w, { externalId: 'ext-dup', key: 'k1' }));
    await expectSqlState(() => tx((em) => insertTx(em, w, { externalId: 'ext-dup', key: 'k2' })), UNIQUE);
  });

  test('REFUND/ROLLBACK exigem referência', async () => {
    const w = await openWallet();
    await expectSqlState(() => tx((em) => insertTx(em, w, { kind: 'REFUND' })), CHECK);
    await expectSqlState(() => tx((em) => insertTx(em, w, { kind: 'ROLLBACK' })), CHECK);
  });

  test('valor zero só é aceito em LOSS', async () => {
    const w = await openWallet();
    await expectSqlState(() => tx((em) => insertTx(em, w, { kind: 'BET', amount: '0' })), CHECK);
    await tx((em) => insertTx(em, w, { kind: 'LOSS', amount: '0' }));
  });

  test('REJECTED exige failure_code', async () => {
    const w = await openWallet();
    await expectSqlState(() => tx((em) => insertTx(em, w, { status: 'REJECTED' })), CHECK);
  });

  test('transação terminal é imutável e não pode ser excluída', async () => {
    const w = await openWallet();
    const id = await tx((em) => insertTx(em, w, { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' }));
    await expectSqlState(
      () => tx((em) => em.execute(`update wager_transactions set status = 'PENDING', failure_code = null where id = ?`, [id])),
      'WG004',
    );
    await expectSqlState(() => tx((em) => em.execute(`delete from wager_transactions where id = ?`, [id])), 'WG003');
  });

  test('campos de negócio não mudam nem em estado não terminal', async () => {
    const w = await openWallet();
    const id = await tx((em) => insertTx(em, w));
    await expectSqlState(
      () => tx((em) => em.execute(`update wager_transactions set amount = 99 where id = ?`, [id])),
      'WG005',
    );
  });

  test('uma referência só pode ser revertida uma vez', async () => {
    const w = await openWallet();
    const betId = await tx((em) => insertTx(em, w, { externalId: 'bet-r', status: 'PROCESSED', balanceAfter: '90.00' }));
    await tx((em) =>
      insertTx(em, w, { kind: 'REFUND', refExternal: 'bet-r', refId: betId, status: 'PROCESSED', balanceAfter: '100.00' }),
    );
    await expectSqlState(
      () =>
        tx((em) =>
          insertTx(em, w, { kind: 'ROLLBACK', refExternal: 'bet-r', refId: betId, status: 'PROCESSED', balanceAfter: '100.00' }),
        ),
      UNIQUE,
    );
  });
});

describe('inbox e outbox', () => {
  test('inbox deduplica por (consumer, messageId)', async () => {
    const ins = () =>
      tx((em) =>
        em.execute(`insert into inbox_messages values ('wager-consumer', 'msg-1', ?, ?, null)`, ['c'.repeat(64), now]),
      );
    await ins();
    await expectSqlState(ins, UNIQUE);
  });

  test('evento publicado não pode voltar a pendente', async () => {
    const id = uuid();
    await tx((em) =>
      em.execute(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, published_at)
         values (?, ?, 'X', '{}', ?, ?, ?)`,
        [id, uuid(), now, now, now],
      ),
    );
    await expectSqlState(
      () => tx((em) => em.execute(`update outbox_messages set published_at = null where id = ?`, [id])),
      'WG010',
    );
  });
});
