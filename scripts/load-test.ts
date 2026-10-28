/**
 * Teste de carga (diferencial opcional). `bun run test:load`
 *
 * Sobe 3 instâncias como processos separados (mesmo banco, mesmas filas) e
 * dispara tráfego HTTP com concorrência fixa durante um tempo fixo:
 *   - 200 wallets "normais" + 1 hot wallet que recebe ~20% do tráfego;
 *   - mix: 70% BET, 20% WIN, 10% replay de uma requisição já enviada.
 * Reporta throughput, p50/p95/p99, taxa de erro, conflitos de lock, outbox lag
 * e verifica a invariante saldo == ledger ao final.
 *
 * Variáveis: LOAD_DURATION_SEC (20), LOAD_CONCURRENCY (64), LOAD_WALLETS (200).
 */
import { DeleteMessageBatchCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';
import { TEST_DATABASE_URL } from '../test/support/database';
import { type Instance, startInstance } from '../test/support/instances';
import { SQS_ENDPOINT, createTestQueues } from '../test/support/sqs';

const DURATION_SEC = Number(process.env.LOAD_DURATION_SEC ?? 20);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 64);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);

const orm = await MikroORM.init(buildOrmConfig({ clientUrl: TEST_DATABASE_URL }));
await orm.getMigrator().down({ to: 0 });
await orm.getMigrator().up();
const { config: queues, sqs, urls } = await createTestQueues(5);

const env = {
  DATABASE_URL: TEST_DATABASE_URL,
  DATABASE_POOL_MAX: '25',
  LOG_LEVEL: 'error',
  SQS_ENDPOINT,
  SQS_WAGER_QUEUE: queues.wagerQueue,
  SQS_WAGER_DLQ: queues.wagerDlq,
  SQS_EVENTS_QUEUE: queues.eventsQueue,
  SQS_WAIT_TIME_SEC: '1',
  OUTBOX_INTERVAL_MS: '100',
  OUTBOX_BATCH_SIZE: '200',
};
const instances: Instance[] = await Promise.all(['load-1', 'load-2', 'load-3'].map((id) => startInstance(id, env)));
console.log(`3 instâncias prontas: ${instances.map((i) => i.url).join(', ')}`);

async function post(i: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${instances[i % 3]!.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

// ---- preparação
const wallets: { walletId: string; playerId: string }[] = [];
for (let i = 0; i < WALLETS + 1; i++) {
  const playerId = crypto.randomUUID();
  const r = await post(i, '/wallets', { playerId, initialBalance: { amount: '100000.00', currency: 'BRL' } });
  wallets.push({ walletId: r.body.id as string, playerId });
}
const hot = wallets[WALLETS]!;
console.log(`${WALLETS} wallets + 1 hot wallet criadas`);

// ---- carga
type Req = { body: Record<string, unknown>; key: string; category: 'hot' | 'normal' | 'replay' };
const sent: Req[] = [];
const latencies: number[] = [];
const byCategory: Record<'hot' | 'normal' | 'replay', number[]> = { hot: [], normal: [], replay: [] };
const statuses = new Map<number, number>();
let networkErrors = 0;
let n = 0;
let lagMax = 0;

function nextRequest(): Req {
  const roll = Math.random();
  if (roll < 0.1 && sent.length > 0) return { ...sent[Math.floor(Math.random() * sent.length)]!, category: 'replay' };
  const isHot = Math.random() < 0.2;
  const w = isHot ? hot : wallets[Math.floor(Math.random() * WALLETS)]!;
  const externalTransactionId = `load-${crypto.randomUUID()}`;
  const isWin = roll >= 0.8;
  const req: Req = {
    category: isHot ? 'hot' : 'normal',
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: `round-${n % 1000}`,
      gameId: 'fortune-chimp',
      kind: isWin ? 'WIN' : 'BET',
      money: { amount: isWin ? '3.00' : '2.00', currency: 'BRL' },
    },
  };
  if (sent.length < 5_000) sent.push(req);
  return req;
}

async function scrape(name: string): Promise<number> {
  let total = 0;
  for (const i of instances) {
    const text = await (await fetch(`${i.url}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (line.startsWith(name) && !line.startsWith('#')) total += Number(line.split(' ').pop());
    }
  }
  return total;
}

const lagSampler = setInterval(async () => {
  const [row] = await orm.em.fork().execute<{ lag: string | null }[]>(
    `select extract(epoch from now() - min(occurred_at))::text as lag from outbox_messages where published_at is null`,
  );
  lagMax = Math.max(lagMax, Number(row?.lag ?? 0));
}, 250);

// Consumidor "downstream" dos eventos: num sistema real alguém consome a fila.
let eventsConsumed = 0;
let consumingEvents = true;
const eventsConsumer = (async () => {
  while (consumingEvents) {
    const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: urls.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    const batch = r.Messages ?? [];
    if (batch.length === 0) continue;
    eventsConsumed += batch.length;
    await sqs.send(new DeleteMessageBatchCommand({
      QueueUrl: urls.events,
      Entries: batch.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle! })),
    }));
  }
})();

const deadline = Date.now() + DURATION_SEC * 1000;
const started = performance.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < deadline) {
      const req = nextRequest();
      const i = n++;
      const t0 = performance.now();
      try {
        const r = await fetch(`${instances[i % 3]!.url}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': req.key },
          body: JSON.stringify(req.body),
        });
        await r.arrayBuffer();
        statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      } catch {
        networkErrors++;
      }
      const ms = performance.now() - t0;
      latencies.push(ms);
      byCategory[req.category].push(ms);
    }
  }),
);
const elapsedSec = (performance.now() - started) / 1000;

// ---- outbox drenando
// Espera a outbox esvaziar, com limite: o gargalo pode ser o emulador de SQS.
const DRAIN_TIMEOUT_SEC = Number(process.env.LOAD_DRAIN_TIMEOUT_SEC ?? 60);
const drainStart = performance.now();
let stillPending = 0;
for (;;) {
  const [row] = await orm.em.fork().execute<{ n: string }[]>(
    `select count(*)::text as n from outbox_messages where published_at is null`,
  );
  stillPending = Number(row!.n);
  if (stillPending === 0 || performance.now() - drainStart > DRAIN_TIMEOUT_SEC * 1000) break;
  await Bun.sleep(100);
}
const drainSec = (performance.now() - drainStart) / 1000;
clearInterval(lagSampler);
consumingEvents = false;
await eventsConsumer;

const lockConflicts = await scrape('wallet_lock_conflicts_total');
const replays = await scrape('wager_duplicates_total{kind="idempotent_replay"}');
const [inv] = await orm.em.fork().execute<{ divergent: string; entries: string }[]>(
  `select count(*) filter (where w.balance <> coalesce(s.total, 0))::text as divergent,
          (select count(*) from wallet_ledger_entries)::text as entries
     from wallets w
     left join (select wallet_id, sum(case when direction = 'CREDIT' then amount else -amount end) total
                  from wallet_ledger_entries group by wallet_id) s on s.wallet_id = w.id`,
);

await Promise.all(instances.map((i) => i.stop()));
await orm.close(true);

// ---- relatório
latencies.sort((a, b) => a - b);
const pct = (xs: number[], q: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(1) : '-';
};
const p = (q: number) => pct(latencies, q);
const line = (name: string, xs: number[]) =>
  `  ${name.padEnd(17)}: n=${String(xs.length).padEnd(6)} p50=${pct(xs, 0.5)}  p95=${pct(xs, 0.95)}  p99=${pct(xs, 0.99)}`;
const total = latencies.length;
const ok = (statuses.get(201) ?? 0) + (statuses.get(422) ?? 0);
const errors = total - ok;
console.log(`
=== Resultado (${new Date().toISOString()}) ===
Ambiente           : ${process.platform}/${process.arch}, ${navigator.hardwareConcurrency} CPUs, bun ${Bun.version}, 3 instâncias + PG + SQS na mesma máquina
Duração / conc.    : ${elapsedSec.toFixed(1)} s, ${CONCURRENCY} requisições simultâneas
Requisições        : ${total}  (${(total / elapsedSec).toFixed(0)} req/s)
Status HTTP        : ${[...statuses.entries()].sort().map(([s, c]) => `${s}=${c}`).join('  ')}  rede=${networkErrors}
Taxa de erro       : ${((errors / total) * 100).toFixed(2)}% (tudo que não é 201/422)
Latência (ms)      : p50=${p(0.5)}  p95=${p(0.95)}  p99=${p(0.99)}  max=${latencies.at(-1)!.toFixed(1)}
${line('hot wallet', byCategory.hot)}
${line('wallets normais', byCategory.normal)}
${line('replays', byCategory.replay)}
Replays detectados : ${replays}
Conflitos de lock  : ${lockConflicts}
Outbox lag máximo  : ${lagMax.toFixed(2)} s; ${stillPending === 0 ? `drenada ${drainSec.toFixed(2)} s após o fim da carga` : `${stillPending} eventos ainda pendentes após ${drainSec.toFixed(0)} s`}
Eventos consumidos : ${eventsConsumed} (consumidor downstream da fila de eventos)
Invariante         : ${inv!.divergent === '0' ? 'OK' : 'VIOLADA'} — ${inv!.divergent} wallets divergentes, ${inv!.entries} lançamentos
`);
process.exit(inv!.divergent === '0' ? 0 : 1);
