import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createApp } from '../../src/bootstrap';
import { loadConfig } from '../../src/config';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TEST_DATABASE_URL, createTestOrm, uuid } from '../support/database';
import { expectLedgerConsistent } from '../support/invariants';

let app: INestApplication;
let base: string;
let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm();
  app = await createApp({
    config: { ...loadConfig(), databaseUrl: TEST_DATABASE_URL, lockTimeoutMs: 300, logLevel: 'silent' },
  });
  await app.listen(0);
  base = await app.getUrl();
  base = base.replace('[::1]', 'localhost');
});

afterAll(async () => {
  await expectLedgerConsistent(orm);
  await app.close();
  await orm.close(true);
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}

async function wallet(amount = '100.00') {
  const playerId = uuid();
  const r = await call('POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(r.status).toBe(201);
  return { walletId: r.body.id as string, playerId };
}

function wager(w: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${uuid()}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const submit = (body: ReturnType<typeof wager>, key = `${body.providerId}:${body.externalTransactionId}`) =>
  call('POST', '/wagering/transactions', body, { 'Idempotency-Key': key });

describe('wallets', () => {
  test('POST /wallets cria com version 1 e saldo inicial', async () => {
    const playerId = uuid();
    const r = await call('POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    expect(r.headers.get('x-correlation-id')).toBeTruthy();

    const dup = await call('POST', '/wallets', { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', retryable: false });
  });

  test('payload inválido: 400 com a lista de problemas', async () => {
    const r = await call('POST', '/wallets', { playerId: 'x', initialBalance: { amount: 10, currency: 'BRL' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_PAYLOAD');
    expect(r.body.error.details.issues.length).toBe(2);
  });

  test('GET de wallet inexistente: 404; id malformado: 400', async () => {
    expect((await call('GET', `/wallets/${uuid()}`)).status).toBe(404);
    expect((await call('GET', '/wallets/nao-e-uuid')).status).toBe(400);
  });
});

describe('POST /wagering/transactions — mapeamento de status', () => {
  test('201 processada; replay idêntico: mesmo status e corpo, idempotentReplay true', async () => {
    const w = await wallet('1000.00');
    const body = wager(w);
    const first = await submit(body);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const replay = await submit(body);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('422 regra de negócio, com failureCode e action', async () => {
    const w = await wallet('10.00');
    const r = await submit(wager(w));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', action: 'GIVE_UP' });
  });

  test('202 aceita com referência pendente', async () => {
    const w = await wallet();
    const r = await submit(wager(w, { kind: 'REFUND', referenceExternalTransactionId: 'ainda-nao-chegou' }));
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('PENDING_REFERENCE');
    expect(r.body.nextAttemptAt).toBeDefined();
  });

  test('409 conflito de idempotência', async () => {
    const w = await wallet();
    const body = wager(w);
    await submit(body);
    const r = await submit({ ...body, money: { amount: '26.00', currency: 'BRL' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', retryable: false });
  });

  test('400 sem Idempotency-Key, JSON malformado, OPENING, dinheiro inválido', async () => {
    const w = await wallet();
    expect((await call('POST', '/wagering/transactions', wager(w))).status).toBe(400);
    expect((await call('POST', '/wagering/transactions', '{nope', { 'Idempotency-Key': 'k' })).status).toBe(400);
    expect((await submit(wager(w, { kind: 'OPENING' }))).status).toBe(400);
    for (const amount of ['1e3', '10.001', '-5.00', 'NaN', '']) {
      const r = await submit(wager(w, { money: { amount, currency: 'BRL' } }));
      expect(r.status).toBe(400);
    }
  });

  test('404 wallet inexistente', async () => {
    const r = await submit(wager({ walletId: uuid(), playerId: uuid() }));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('503 retryable quando o lock da wallet não sai a tempo', async () => {
    const w = await wallet();
    const blocker = await MikroORM.init(buildOrmConfig({ clientUrl: TEST_DATABASE_URL }));
    const em = blocker.em.fork();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locking = em.transactional(async (tx) => {
      await tx.execute('select 1 from wallets where id = ? for update', [w.walletId]);
      await held;
    });
    await Bun.sleep(50);

    const r = await submit(wager(w));
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('1');
    expect(r.body.error).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE', retryable: true });

    release();
    await locking;
    await blocker.close(true);

    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain('wallet_lock_conflicts_total{reason="lock_timeout"} 1');
  });
});

describe('consultas', () => {
  test('GET por id interno e por id do provedor', async () => {
    const w = await wallet();
    const body = wager(w, { externalTransactionId: 'lookup-1' });
    const created = await submit(body);
    const byId = await call('GET', `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ externalTransactionId: 'lookup-1', status: 'PROCESSED', kind: 'BET' });
    const byExt = await call('GET', '/providers/provider-a/wagering/transactions/lookup-1');
    expect(byExt.body.transactionId).toBe(created.body.transactionId);
    expect((await call('GET', '/providers/provider-a/wagering/transactions/nope')).status).toBe(404);
  });

  test('ledger paginado e reconciliação', async () => {
    const w = await wallet('100.00');
    for (let i = 0; i < 3; i++) await submit(wager(w, { money: { amount: '1.00', currency: 'BRL' } }));
    const p1 = await call('GET', `/wallets/${w.walletId}/ledger?limit=2`);
    expect(p1.body.entries).toHaveLength(2);
    const p2 = await call('GET', `/wallets/${w.walletId}/ledger?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.entries).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();
    expect((await call('GET', `/wallets/${w.walletId}/ledger?limit=999`)).status).toBe(400);

    const rec = await call('POST', `/wallets/${w.walletId}/reconciliation`);
    expect(rec.body).toMatchObject({ consistent: true, checkedEntries: 4, difference: { amount: '0.00', currency: 'BRL' } });
  });
});

describe('health', () => {
  test('live e ready abertos', async () => {
    expect((await call('GET', '/health/live')).body).toEqual({ status: 'ok' });
    const ready = await call('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.postgres.status).toBe('up');
  });
});
