/**
 * Mensageria contra PostgreSQL e SQS reais (moto/LocalStack). Cobre: inbox e
 * redelivery, morte entre commit e ack, retry com backoff, DLQ, SIGTERM,
 * publishers concorrentes na outbox, crash do publisher e worker de referências.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { parseSubmitWager, type SubmitWagerCommand } from '../../src/application/commands';
import { TransientInfrastructureError } from '../../src/application/errors';
import { OutboxRelay } from '../../src/application/outbox-relay';
import type { EventPublisher, PublishResult } from '../../src/application/ports';
import { WageringService } from '../../src/application/wagering.service';
import { Money } from '../../src/domain/money';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { ExponentialBackoff } from '../../src/domain/retry-policy';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { WagerConsumer, type WagerSubmitter } from '../../src/infrastructure/messaging/wager-consumer';
import { MikroOrmOutboxStore } from '../../src/infrastructure/persistence/mikro-orm-outbox.store';
import { MikroOrmWageringStore } from '../../src/infrastructure/persistence/mikro-orm-wagering.store';
import { silentLogger } from '../../src/application/ports';
import { Metrics } from '../../src/observability/metrics';
import { referenceRetryTick } from '../../src/workers/reference-retry.worker';
import { createTestOrm, uuid } from '../support/database';
import { count, expectLedgerConsistent } from '../support/invariants';
import { createTestQueues, drain, send, wagerMessage, waitFor } from '../support/sqs';

let orm: MikroORM;
let store: MikroOrmWageringStore;
let service: WageringService;

beforeAll(async () => {
  orm = await createTestOrm();
  store = new MikroOrmWageringStore(orm);
  service = new WageringService(store, { referenceRetry: new ExponentialBackoff(200, 1_000, 5) });
});

afterAll(async () => {
  await expectLedgerConsistent(orm);
  await orm.close(true);
});

async function newWallet(balance = '100.00') {
  const playerId = uuid();
  const w = await service.createWallet({ playerId, initialBalance: Money.from({ amount: balance, currency: 'BRL' }), correlationId: 'c' });
  return { walletId: w.id, playerId };
}

function data(w: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
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

const balance = async (walletId: string) =>
  (await orm.em.fork().execute<{ b: string }[]>('select balance::text as b from wallets where id = ?', [walletId]))[0]!.b;

async function consumerFor(submitter: WagerSubmitter = service, maxReceiveCount = 3, Klass = WagerConsumer) {
  const q = await createTestQueues(maxReceiveCount);
  const metrics = new Metrics();
  const consumer = new Klass(q.sqs, submitter, silentLogger, {
    queueUrl: q.urls.wager,
    dlqUrl: q.urls.dlq,
    consumerName: 'wager-consumer',
    concurrency: 5,
    maxReceiveCount,
    visibilityTimeoutSec: 1,
    waitTimeSec: 1,
    retryBackoff: new ExponentialBackoff(1_000, 1_000, 100),
  }, metrics);
  return { ...q, consumer, metrics };
}

describe('consumidor SQS', () => {
  test('processa, confirma depois do commit e registra o inbox', async () => {
    const w = await newWallet();
    const { sqs, urls, consumer } = await consumerFor();
    const msg = wagerMessage(data(w, { externalTransactionId: 'sqs-1' }));
    await send(sqs, urls.wager, msg);
    consumer.start();
    await waitFor(async () => (await balance(w.walletId)) === '90.00');
    await consumer.stop(5_000);

    expect(await count(orm, 'select 1 from inbox_messages where message_id = ?', [msg.messageId])).toBe(1);
    expect(await drain(sqs, urls.wager)).toHaveLength(0);
  });

  test('redelivery da mesma mensagem não duplica o efeito', async () => {
    const w = await newWallet();
    const telemetry = new Metrics();
    const observed = new WageringService(store, { telemetry });
    const { sqs, urls, consumer } = await consumerFor(observed);
    const msg = wagerMessage(data(w));
    // Mesmo messageId em 3 entregas que o FIFO não deduplicou (grupos diferentes = em paralelo).
    for (let i = 0; i < 3; i++) await send(sqs, urls.wager, msg, `g-${i}`);
    consumer.start();
    await waitFor(async () =>
      (await telemetry.duplicates.get()).values.find((x) => x.labels.kind === 'inbox_duplicate')?.value === 2,
    );
    await consumer.stop(5_000);
    expect(await balance(w.walletId)).toBe('90.00');
    expect(await count(orm, 'select 1 from inbox_messages where message_id = ?', [msg.messageId])).toBe(1);
    expect(await count(orm, 'select 1 from wallet_ledger_entries where wallet_id = ? and direction = ?', [w.walletId, 'DEBIT'])).toBe(1);
    expect(await drain(sqs, urls.wager)).toHaveLength(0);
  });

  test('worker morto depois do commit e antes do ack: reentrega vira replay', async () => {
    const w = await newWallet();
    let crashes = 0;
    class CrashBeforeAck extends WagerConsumer {
      protected override async ack(message: Message, fields: Record<string, unknown>): Promise<void> {
        if (crashes++ === 0) return; // "morreu": commit feito, DeleteMessage nunca enviado
        return super.ack(message, fields);
      }
    }
    const { sqs, urls, consumer } = await consumerFor(service, 3, CrashBeforeAck);
    await send(sqs, urls.wager, wagerMessage(data(w, { externalTransactionId: 'crash-1' })));
    consumer.start();
    await waitFor(async () => crashes >= 2, 20_000); // voltou após o visibility timeout
    await consumer.stop(5_000);

    expect(await balance(w.walletId)).toBe('90.00');
    expect(await count(orm, `select 1 from wager_transactions where external_transaction_id = 'crash-1'`)).toBe(1);
    expect(await drain(sqs, urls.wager)).toHaveLength(0);
  });

  test('falha transitória: retry com backoff até dar certo', async () => {
    const w = await newWallet();
    let failures = 0;
    const flaky: WagerSubmitter = {
      submit: async (c: SubmitWagerCommand) => {
        if (failures < 2) {
          failures++;
          throw new TransientInfrastructureError('lock_timeout');
        }
        return service.submit(c);
      },
    };
    const { sqs, urls, consumer, metrics } = await consumerFor(flaky, 5);
    await send(sqs, urls.wager, wagerMessage(data(w)));
    consumer.start();
    await waitFor(async () => (await balance(w.walletId)) === '90.00', 20_000);
    await consumer.stop(5_000);
    expect(failures).toBe(2);
    expect((await metrics.retries.get()).values.find((v) => v.labels.component === 'sqs')?.value).toBe(2);
    expect(await drain(sqs, urls.dlq)).toHaveLength(0);
  });

  test('falha transitória que não passa: DLQ ao atingir o limite', async () => {
    const down: WagerSubmitter = { submit: async () => { throw new TransientInfrastructureError('database_unavailable'); } };
    const { sqs, urls, consumer } = await consumerFor(down, 2);
    await send(sqs, urls.wager, wagerMessage(data({ walletId: uuid(), playerId: uuid() })));
    consumer.start();
    const dead = await waitFor(async () => {
      const m = await drain(sqs, urls.dlq);
      return m.length ? m : undefined;
    }, 20_000);
    await consumer.stop(5_000);
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toBe('retries_exhausted');
  });

  test('erro permanente vai direto para a DLQ; regra de negócio só confirma', async () => {
    const w = await newWallet();
    const { sqs, urls, consumer, metrics } = await consumerFor();
    await service.submit(
      parseSubmitWager(data(w, { externalTransactionId: 'taken' }), { idempotencyKey: 'provider-a:taken', correlationId: 'c' }),
    );
    await send(sqs, urls.wager, '{json quebrado', 'a');
    await send(sqs, urls.wager, wagerMessage(data(w, { money: { amount: '1e3', currency: 'BRL' } })), 'b');
    await send(sqs, urls.wager, wagerMessage(data(w, { kind: 'REFUND' })), 'c'); // sem referência
    // conflito de idempotência = regra de negócio: ack, não DLQ
    await send(sqs, urls.wager, wagerMessage(data(w, { externalTransactionId: 'taken', money: { amount: '99.00', currency: 'BRL' } })), 'd');
    consumer.start();
    await waitFor(async () => {
      const total = (await metrics.dlqMessages.get()).values.reduce((s, v) => s + v.value, 0);
      return total === 3;
    });
    await Bun.sleep(1_500);
    await consumer.stop(5_000);

    const dead = await drain(sqs, urls.dlq);
    expect(dead.map((m) => m.MessageAttributes?.failureReason?.StringValue).sort()).toEqual(
      ['invalid_payload', 'invalid_payload', 'malformed_json'],
    );
    expect(await drain(sqs, urls.wager)).toHaveLength(0);
  });

  test('SIGTERM: termina o que está em andamento e devolve o que não começou', async () => {
    const w = await newWallet();
    let started = 0;
    const slow: WagerSubmitter = {
      submit: async (c) => {
        started++;
        await Bun.sleep(1_500);
        return service.submit(c);
      },
    };
    const { sqs, urls, consumer } = await consumerFor(slow);
    // Mesmo grupo: a segunda só começa depois da primeira.
    await send(sqs, urls.wager, wagerMessage(data(w, { externalTransactionId: 'first' })), 'same');
    await send(sqs, urls.wager, wagerMessage(data(w, { externalTransactionId: 'second' })), 'same');
    consumer.start();
    await waitFor(async () => started === 1);
    await consumer.stop(10_000);

    expect(started).toBe(1);
    expect(await count(orm, `select 1 from wager_transactions where external_transaction_id = 'first'`)).toBe(1);
    expect(await count(orm, `select 1 from wager_transactions where external_transaction_id = 'second'`)).toBe(0);
    // A que não começou voltou para a fila na hora (visibilidade 0), sem esperar timeout.
    const back = await drain(sqs, urls.wager);
    expect(back.map((m) => JSON.parse(m.Body!).data.externalTransactionId)).toEqual(['second']);
  });
});

describe('outbox', () => {
  async function seedEvents(n: number) {
    const w = await newWallet('1000.00');
    for (let i = 0; i < n; i++) {
      await service.submit(
        parseSubmitWager(data(w, { money: { amount: '1.00', currency: 'BRL' } }), { idempotencyKey: `k-${uuid()}`, correlationId: 'c' }),
      );
    }
  }
  const pending = () => count(orm, 'select 1 from outbox_messages where published_at is null');

  test('dois publishers concorrentes: nada se perde, nada sai duas vezes', async () => {
    await new MikroOrmOutboxStore(orm).claim('cleanup', new Date(), 10_000, 0); // reseta leases antigos
    const q = await createTestQueues();
    const real = new SqsEventPublisher(q.sqs, q.urls.events);
    const sent: string[] = [];
    const spy: EventPublisher = {
      publish: async (m) => {
        sent.push(...m.map((x) => x.id));
        return real.publish(m);
      },
    };
    // Publica o que já existia antes, para medir só os novos.
    const warm = new OutboxRelay(new MikroOrmOutboxStore(orm), real, { owner: 'warm', batchSize: 1000, leaseMs: 30_000 });
    while ((await warm.tick()).claimed > 0);
    await drain(q.sqs, q.urls.events);

    await seedEvents(40); // 1 da abertura da wallet + 40 x 2 = 81 eventos
    const relays = ['A', 'B'].map(
      (owner) => new OutboxRelay(new MikroOrmOutboxStore(orm), spy, { owner, batchSize: 7, leaseMs: 30_000 }),
    );
    const run = async (r: OutboxRelay) => { while ((await r.tick()).claimed > 0); };
    await Promise.all(relays.map(run));

    expect(await pending()).toBe(0);
    expect(sent).toHaveLength(81);
    expect(new Set(sent).size).toBe(81);
    const delivered = await drain(q.sqs, q.urls.events);
    expect(new Set(delivered.map((m) => JSON.parse(m.Body!).eventId)).size).toBe(81);
  });

  test('commit feito, publisher morre antes de publicar/marcar: outra instância assume após o lease', async () => {
    const q = await createTestQueues();
    const real = new SqsEventPublisher(q.sqs, q.urls.events);
    const outboxStore = new MikroOrmOutboxStore(orm);
    while ((await new OutboxRelay(outboxStore, real, { owner: 'warm', batchSize: 1000, leaseMs: 30_000 }).tick()).claimed > 0);
    await drain(q.sqs, q.urls.events);
    await seedEvents(1); // abertura + Processed + BalanceChanged = 3 eventos

    // Instância 1: pega o lote, publica e "morre" antes de marcar como publicado.
    const crashed = new OutboxRelay(
      { ...outboxStore, claim: outboxStore.claim.bind(outboxStore), stats: outboxStore.stats.bind(outboxStore),
        scheduleRetry: outboxStore.scheduleRetry.bind(outboxStore),
        markPublished: async () => { throw new Error('process killed'); } },
      real,
      { owner: 'dead', batchSize: 10, leaseMs: 300 },
    );
    expect(crashed.tick()).rejects.toThrow('process killed');
    await Bun.sleep(50);
    expect(await pending()).toBe(3);

    // Instância 2 antes do lease expirar: não pega nada.
    const survivor = new OutboxRelay(outboxStore, real, { owner: 'alive', batchSize: 10, leaseMs: 30_000 });
    expect((await survivor.tick()).claimed).toBe(0);
    await Bun.sleep(400);
    expect((await survivor.tick()).published).toBe(3);
    expect(await pending()).toBe(0);

    // Publicado duas vezes com o mesmo eventId: seguro para o consumidor.
    const delivered = await drain(q.sqs, q.urls.events);
    expect(new Set(delivered.map((m) => JSON.parse(m.Body!).eventId)).size).toBe(3);
  });

  test('broker fora do ar: evento continua pendente com backoff', async () => {
    const outboxStore = new MikroOrmOutboxStore(orm);
    const q = await createTestQueues();
    while ((await new OutboxRelay(outboxStore, new SqsEventPublisher(q.sqs, q.urls.events), { owner: 'w', batchSize: 1000, leaseMs: 30_000 }).tick()).claimed > 0);
    await seedEvents(1);
    const down: EventPublisher = { publish: async (): Promise<PublishResult> => { throw new Error('sqs unreachable'); } };
    const r = await new OutboxRelay(outboxStore, down, { owner: 'x', batchSize: 10, leaseMs: 30_000 }).tick();
    expect(r.failed).toBe(3);
    const rows = await orm.em.fork().execute<{ attempts: number; due: boolean; last_error: string }[]>(
      'select attempts, next_attempt_at > now() as due, last_error from outbox_messages where published_at is null',
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.attempts === 1 && x.due && x.last_error.includes('unreachable'))).toBe(true);
  });
});

describe('worker de referências pendentes', () => {
  test('ROLLBACK entregue antes da referência é aplicado pelo worker', async () => {
    const w = await newWallet('100.00');
    const rb = await service.submit(
      parseSubmitWager(data(w, { kind: 'ROLLBACK', externalTransactionId: 'rb-early', referenceExternalTransactionId: 'bet-late' }), {
        idempotencyKey: 'provider-a:rb-early', correlationId: 'c' }),
    );
    expect(rb.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    await service.submit(
      parseSubmitWager(data(w, { externalTransactionId: 'bet-late' }), { idempotencyKey: 'provider-a:bet-late', correlationId: 'c' }),
    );
    const tick = referenceRetryTick(store, service, silentLogger, { batchSize: 10, leaseMs: 30_000 });
    await tick();
    const [row] = await orm.em.fork().execute<{ status: string }[]>('select status from wager_transactions where id = ?', [rb.transaction.id]);
    expect(row!.status).toBe('PROCESSED');
    expect(await balance(w.walletId)).toBe('100.00');
  });
});
