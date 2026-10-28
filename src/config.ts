const env = (name: string, fallback: string) => process.env[name] ?? fallback;
const int = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`env ${name} must be a non-negative integer`);
  return value;
};

export interface AppConfig {
  instanceId: string;
  port: number;
  databaseUrl: string;
  databasePoolMax: number;
  lockTimeoutMs: number;
  logLevel: string;
  aws: {
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  sqs: {
    wagerQueue: string;
    wagerDlq: string;
    eventsQueue: string;
    consumerName: string;
    /** Quantas mensagens processar ao mesmo tempo por instância. */
    concurrency: number;
    /** Tentativas antes de mandar para a DLQ (redrive manual por erro permanente). */
    maxReceiveCount: number;
    visibilityTimeoutSec: number;
    waitTimeSec: number;
    enabled: boolean;
  };
  workers: {
    outboxEnabled: boolean;
    outboxIntervalMs: number;
    outboxBatchSize: number;
    outboxLeaseMs: number;
    referenceEnabled: boolean;
    referenceIntervalMs: number;
    referenceBatchSize: number;
    referenceLeaseMs: number;
  };
  referenceRetry: { baseDelayMs: number; maxDelayMs: number; maxAttempts: number };
  shutdownTimeoutMs: number;
}

export function loadConfig(): AppConfig {
  return {
    instanceId: env('INSTANCE_ID', `instance-${process.pid}`),
    port: int('PORT', 3000),
    databaseUrl: env('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/wagering'),
    databasePoolMax: int('DATABASE_POOL_MAX', 20),
    lockTimeoutMs: int('LOCK_TIMEOUT_MS', 5_000),
    logLevel: env('LOG_LEVEL', 'info'),
    aws: {
      region: env('AWS_REGION', 'us-east-1'),
      endpoint: process.env.SQS_ENDPOINT,
      accessKeyId: env('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: env('AWS_SECRET_ACCESS_KEY', 'test'),
    },
    sqs: {
      wagerQueue: env('SQS_WAGER_QUEUE', 'wager-transactions.fifo'),
      wagerDlq: env('SQS_WAGER_DLQ', 'wager-transactions-dlq.fifo'),
      eventsQueue: env('SQS_EVENTS_QUEUE', 'wager-events.fifo'),
      consumerName: env('SQS_CONSUMER_NAME', 'wager-transactions-consumer'),
      concurrency: int('SQS_CONCURRENCY', 10),
      maxReceiveCount: int('SQS_MAX_RECEIVE_COUNT', 5),
      visibilityTimeoutSec: int('SQS_VISIBILITY_TIMEOUT_SEC', 30),
      waitTimeSec: int('SQS_WAIT_TIME_SEC', 10),
      enabled: env('SQS_CONSUMER_ENABLED', 'true') === 'true',
    },
    workers: {
      outboxEnabled: env('OUTBOX_WORKER_ENABLED', 'true') === 'true',
      outboxIntervalMs: int('OUTBOX_INTERVAL_MS', 500),
      outboxBatchSize: int('OUTBOX_BATCH_SIZE', 50),
      outboxLeaseMs: int('OUTBOX_LEASE_MS', 30_000),
      referenceEnabled: env('REFERENCE_WORKER_ENABLED', 'true') === 'true',
      referenceIntervalMs: int('REFERENCE_INTERVAL_MS', 1_000),
      referenceBatchSize: int('REFERENCE_BATCH_SIZE', 50),
      referenceLeaseMs: int('REFERENCE_LEASE_MS', 30_000),
    },
    referenceRetry: {
      baseDelayMs: int('REFERENCE_RETRY_BASE_MS', 2_000),
      maxDelayMs: int('REFERENCE_RETRY_MAX_DELAY_MS', 600_000),
      maxAttempts: int('REFERENCE_RETRY_MAX_ATTEMPTS', 12),
    },
    shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 20_000),
  };
}

export const APP_CONFIG = Symbol('AppConfig');
