/**
 * Três PROCESSOS da aplicação (bun run src/main.ts) sobre o mesmo PostgreSQL
 * e as mesmas filas SQS. Cobre os itens 4, 5 e 8 da seção 13:
 *   - ≥ 3 instâncias simultâneas (HTTP e SQS);
 *   - instância morta com SIGKILL no meio da carga;
 *   - reinício completo do serviço com comprovação da consistência final.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { QueueUrls } from '../../src/infrastructure/messaging/sqs';
import type { AppConfig } from '../../src/config';
import { TEST_DATABASE_URL, createTestOrm, uuid } from '../support/database';
import { type Instance, startInstance } from '../support/instances';
import { count, expectLedgerConsistent } from '../support/invariants';
import { SQS_ENDPOINT, createTestQueues, drain, send, wagerMessage, waitFor } from '../support/sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';

let orm: MikroORM;
let sqs: SQSClient;
let urls: QueueUrls;
let queues: AppConfig['sqs'];
let instances: Instance[] = [];
let env: Record<string, string>;

beforeAll(async () => {
  orm = await createTestOrm();
  const q = await createTestQueues(5);
  sqs = q.sqs;
  urls = q.urls;
  queues = q.config;
  env = {
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_POOL_MAX: '15',
    LOCK_TIMEOUT_MS: '15000',
    LOG_LEVEL: 'warn',
    SQS_ENDPOINT,
    SQS_WAGER_QUEUE: queues.wagerQueue,
    SQS_WAGER_DLQ: queues.wagerDlq,
    SQS_EVENTS_QUEUE: queues.eventsQueue,
    SQS_CREATE_QUEUES: 'false',
    SQS_WAIT_TIME_SEC: '1',
    SQS_VISIBILITY_TIMEOUT_SEC: '3',
    SQS_CONCURRENCY: '10',
    OUTBOX_INTERVAL_MS: '100',
    REFERENCE_INTERVAL_MS: '200',
    REFERENCE_RETRY_BASE_MS: '200',
    SHUTDOWN_TIMEOUT_MS: '5000',
  };
  instances = await Promise.all(['app-1', 'app-2', 'app-3'].map((id) => startInstance(id, env)));
}, 60_000);

afterAll(async () => {
  await Promise.all(instances.map((i) => i.stop()));
  await expectLedgerConsistent(orm);
  await orm.close(true);
});

const pick = (i: number) => instances[i % instances.length]!;

async function post(instance: Instance, path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${instance.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, body: (await r.json()) as any };
}

async function newWallet(balance: string, via = instances[0]!) {
  const playerId = uuid();
  const r = await post(via, '/wallets', { playerId, initialBalance: { amount: balance, currency: 'BRL' } });
  expect(r.status).toBe(201);
  return { walletId: r.body.id as string, playerId };
}

function wager(w: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${uuid()}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

const submit = (instance: Instance, body: ReturnType<typeof wager>) =>
  post(instance, '/wagering/transactions', body, { 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` });

const balance = async (walletId: string) =>
  (await orm.em.fork().execute<{ b: string }[]>('select balance::text as b from wallets where id = ?', [walletId]))[0]!.b;

describe('3 instâncias via HTTP', () => {
  test('100.00 e duas apostas de 80.00 em instâncias diferentes (20 rodadas)', async () => {
    for (let round = 0; round < 20; round++) {
      const w = await newWallet('100.00');
      const [a, b] = await Promise.all([
        submit(pick(round), wager(w, { money: { amount: '80.00', currency: 'BRL' } })),
        submit(pick(round + 1), wager(w, { money: { amount: '80.00', currency: 'BRL' } })),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      expect(await balance(w.walletId)).toBe('20.00');
    }
  });

  test('a mesma aposta 60 vezes, espalhada pelas 3 instâncias: um único débito', async () => {
    const w = await newWallet('100.00');
    const body = wager(w, { externalTransactionId: 'same-across-instances' });
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => submit(pick(i), body)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(await balance(w.walletId)).toBe('90.00');
  });

  test('hot wallet: 150 operações misturadas nas 3 instâncias, saldo nunca negativo', async () => {
    const w = await newWallet('30.00');
    const results = await Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        submit(pick(i), wager(w, i % 4 === 0 ? { kind: 'WIN', money: { amount: '6.00', currency: 'BRL' } } : {})),
      ),
    );
    expect(results.every((r) => [201, 422].includes(r.status))).toBe(true);
    const rejected = results.filter((r) => r.status === 422);
    expect(rejected.every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    const [row] = await orm.em.fork().execute<{ negative: string }[]>(
      `select count(*)::text as negative from wallet_ledger_entries where wallet_id = ? and balance_after < 0`,
      [w.walletId],
    );
    expect(row!.negative).toBe('0');
  });
});

describe('3 consumidores SQS, um morto com SIGKILL no meio', () => {
  test('mensagens duplicadas e concorrentes: nenhum efeito duplicado, nada perdido', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('500.00')));
    const messages = wallets.flatMap((w) =>
      Array.from({ length: 20 }, (_, i) =>
        wagerMessage(wager(w, i % 5 === 0 ? { kind: 'WIN', money: { amount: '15.00', currency: 'BRL' } } : {})),
      ),
    );
    // Cada mensagem 2x, em grupos diferentes: as duplicatas podem ir para instâncias diferentes ao mesmo tempo.
    const sends = messages.flatMap((m, i) => [send(sqs, urls.wager, m, `g-${i}-a`), send(sqs, urls.wager, m, `g-${i}-b`)]);
    await Promise.all(sends);

    // Derruba uma instância no meio do processamento.
    await waitFor(async () => (await count(orm, `select 1 from inbox_messages`)) >= 40, 30_000, 50);
    await instances[1]!.kill();

    const externalIds = messages.map((m) => (m.data as unknown as { externalTransactionId: string }).externalTransactionId);
    await waitFor(
      async () =>
        (await count(orm, `select 1 from wager_transactions where external_transaction_id in (?)`, [externalIds])) === externalIds.length,
      60_000,
      250,
    );
    // Cada mensagem: no máximo 1 lançamento por transação; nenhuma transação duplicada.
    expect(
      await count(
        orm,
        `select transaction_id from wallet_ledger_entries where transaction_id in
           (select id from wager_transactions where external_transaction_id in (?))
         group by transaction_id having count(*) > 1`,
        [externalIds],
      ),
    ).toBe(0);
    expect(await count(orm, `select 1 from inbox_messages where message_id in (?)`, [messages.map((m) => m.messageId)])).toBe(
      messages.length,
    );
    await expectLedgerConsistent(orm);
    // Nada foi para a DLQ.
    expect(await drain(sqs, urls.dlq)).toHaveLength(0);
  }, 120_000);
});

describe('reinício do serviço', () => {
  test('desliga tudo com SIGTERM, religa, termina o trabalho pendente e continua consistente', async () => {
    const survivors = instances.filter((_, i) => i !== 1);
    const w = await newWallet('100.00', survivors[0]);

    // ROLLBACK chega antes da BET: fica pendente.
    const rb = await submit(survivors[0]!, wager(w, { kind: 'ROLLBACK', externalTransactionId: 'rb-restart', referenceExternalTransactionId: 'bet-restart', money: { amount: '40.00', currency: 'BRL' } }));
    expect(rb.status).toBe(202);

    // Shutdown gracioso de todas as instâncias vivas: código de saída 0.
    const codes = await Promise.all(survivors.map((i) => i.stop()));
    expect(codes.every((c) => c === 0)).toBe(true);

    // Com o serviço fora do ar, chegam mensagens na fila: a BET referenciada e uma aposta nova.
    await send(sqs, urls.wager, wagerMessage(wager(w, { externalTransactionId: 'bet-restart', money: { amount: '40.00', currency: 'BRL' } })), w.walletId);
    await send(sqs, urls.wager, wagerMessage(wager(w, { externalTransactionId: 'while-down', money: { amount: '5.00', currency: 'BRL' } })), w.walletId);

    instances = await Promise.all(['app-4', 'app-5', 'app-6'].map((id) => startInstance(id, env)));

    // Depois do reinício: fila consumida, ROLLBACK aplicado pelo worker.
    await waitFor(async () => {
      const [row] = await orm.em.fork().execute<{ status: string }[]>(
        `select status from wager_transactions where external_transaction_id = 'rb-restart'`,
      );
      return row?.status === 'PROCESSED';
    }, 30_000, 200);
    await waitFor(async () => (await count(orm, `select 1 from wager_transactions where external_transaction_id = 'while-down'`)) === 1);
    expect(await balance(w.walletId)).toBe('95.00'); // 100 - 40 (BET) + 40 (ROLLBACK) - 5

    // Outbox drenada pelas novas instâncias.
    await waitFor(async () => (await count(orm, 'select 1 from outbox_messages where published_at is null')) === 0, 30_000, 200);

    // Reconciliação em todas as wallets, via API das instâncias novas.
    const all = await orm.em.fork().execute<{ id: string }[]>('select id from wallets');
    const reports = await Promise.all(all.map((x, i) => post(pick(i), `/wallets/${x.id}/reconciliation`, {})));
    expect(reports.every((r) => r.status === 200 && r.body.consistent === true)).toBe(true);
  }, 120_000);
});
