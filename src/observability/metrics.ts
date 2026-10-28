import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { WageringTelemetry } from '../application/ports';

/**
 * Métricas Prometheus (GET /metrics). Cobrem o mínimo da seção 12:
 * transações por status, duplicatas, retries, DLQ, conflitos de lock,
 * outbox lag e latência de processamento.
 */
export class Metrics implements WageringTelemetry {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações decididas, por status final da decisão',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicatas detectadas (replay idempotente, conflito de key, inbox)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Novas tentativas agendadas (referência pendente, mensagem SQS, publicação da outbox)',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });

  readonly dlqMessages = new Counter({
    name: 'wager_dlq_messages_total',
    help: 'Mensagens enviadas para a DLQ por esta instância',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly dlqDepth = new Gauge({
    name: 'wager_dlq_depth',
    help: 'Mensagens aproximadas na DLQ (amostrado)',
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Transações abortadas por disputa de lock (lock_timeout, deadlock)',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Eventos ainda não publicados',
    registers: [this.registry],
  });

  readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade do evento pendente mais antigo',
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Eventos publicados',
    labelNames: ['event_type'] as const,
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência do processamento de uma transação',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly reconciliations = new Counter({
    name: 'wallet_reconciliations_total',
    help: 'Reconciliações executadas',
    labelNames: ['consistent'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionSettled(status: string, kind: string, source: string): void {
    this.transactions.inc({ status, kind, source });
  }

  duplicateDetected(kind: 'idempotent_replay' | 'idempotency_conflict' | 'inbox_duplicate'): void {
    this.duplicates.inc({ kind });
  }

  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }

  processingLatency(source: string, seconds: number): void {
    this.processingDuration.observe({ source }, seconds);
  }

  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({ consistent: String(consistent) });
  }

  retry(component: 'reference' | 'sqs' | 'outbox'): void {
    this.retries.inc({ component });
  }
}
