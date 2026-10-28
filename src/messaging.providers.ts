import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  Optional,
  type Provider,
} from '@nestjs/common';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { OutboxRelay } from './application/outbox-relay';
import { LOGGER, WAGERING_STORE, type AppLogger, type WageringStore } from './application/ports';
import { WageringService } from './application/wagering.service';
import { APP_CONFIG, type AppConfig } from './config';
import type { ReadinessCheck } from './http/health.controller';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { type QueueUrls, createSqsClient, ensureQueues, resolveQueueUrls } from './infrastructure/messaging/sqs';
import { WagerConsumer } from './infrastructure/messaging/wager-consumer';
import { MikroOrmOutboxStore } from './infrastructure/persistence/mikro-orm-outbox.store';
import { errorFields } from './observability/logger';
import { Metrics } from './observability/metrics';
import { PeriodicWorker } from './workers/periodic-worker';
import { referenceRetryTick } from './workers/reference-retry.worker';

export const SQS_CLIENT = Symbol('SQSClient');
export const QUEUE_URLS = Symbol('QueueUrls');
export const WORKERS = Symbol('Workers');
export const SQS_READINESS = 'SQS_READINESS';

async function resolveWithRetry(sqs: SQSClient, config: AppConfig, logger: AppLogger): Promise<QueueUrls> {
  for (let attempt = 1; ; attempt++) {
    try {
      return config.sqs.createQueues ? await ensureQueues(sqs, config.sqs) : await resolveQueueUrls(sqs, config.sqs);
    } catch (error) {
      if (attempt >= 15) throw error;
      logger.warn({ attempt, ...errorFields(error) }, 'waiting for SQS queues');
      await Bun.sleep(1_000);
    }
  }
}

/**
 * Sobe consumidor e workers depois que a aplicação está pronta e os para
 * antes de fechar o pool do banco (onApplicationShutdown do DatabaseLifecycle).
 * Ordem no SIGTERM: para de consumir -> termina o que está em andamento ou
 * devolve a visibilidade -> para os workers -> fecha HTTP -> fecha o banco.
 */
@Injectable()
export class MessagingLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WORKERS) private readonly workers: PeriodicWorker[],
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Optional() @Inject(WagerConsumer) private readonly consumer?: WagerConsumer,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.sqs.enabled) this.consumer?.start();
    for (const w of this.workers) w.start();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info({ signal }, 'graceful shutdown started');
    await this.consumer?.stop(this.config.shutdownTimeoutMs);
    await Promise.all(this.workers.map((w) => w.stop()));
  }
}

export function messagingProviders(config: AppConfig): Provider[] {
  return [
    { provide: SQS_CLIENT, useFactory: () => createSqsClient(config.aws) },
    {
      provide: QUEUE_URLS,
      inject: [SQS_CLIENT, LOGGER],
      useFactory: (sqs: SQSClient, logger: AppLogger) => resolveWithRetry(sqs, config, logger),
    },
    {
      provide: WagerConsumer,
      inject: [SQS_CLIENT, QUEUE_URLS, WageringService, LOGGER, Metrics],
      useFactory: (sqs: SQSClient, urls: QueueUrls, service: WageringService, logger: AppLogger, metrics: Metrics) =>
        new WagerConsumer(
          sqs,
          service,
          logger,
          {
            queueUrl: urls.wager,
            dlqUrl: urls.dlq,
            consumerName: config.sqs.consumerName,
            concurrency: config.sqs.concurrency,
            maxReceiveCount: config.sqs.maxReceiveCount,
            visibilityTimeoutSec: config.sqs.visibilityTimeoutSec,
            waitTimeSec: config.sqs.waitTimeSec,
          },
          metrics,
        ),
    },
    {
      provide: WORKERS,
      inject: [MikroORM, SQS_CLIENT, QUEUE_URLS, WAGERING_STORE, WageringService, LOGGER, Metrics],
      useFactory: (
        orm: MikroORM,
        sqs: SQSClient,
        urls: QueueUrls,
        store: WageringStore,
        service: WageringService,
        logger: AppLogger,
        metrics: Metrics,
      ): PeriodicWorker[] => {
        const workers: PeriodicWorker[] = [];
        const outboxStore = new MikroOrmOutboxStore(orm);
        const w = config.workers;

        if (w.outboxEnabled) {
          const relay = new OutboxRelay(outboxStore, new SqsEventPublisher(sqs, urls.events), {
            owner: config.instanceId,
            batchSize: w.outboxBatchSize,
            leaseMs: w.outboxLeaseMs,
            logger,
            onPublished: (m) => metrics.outboxPublished.inc({ event_type: m.eventType }),
            onRetry: () => metrics.retry('outbox'),
          });
          workers.push(
            new PeriodicWorker('outbox-publisher', w.outboxIntervalMs, async () => {
              const r = await relay.tick();
              return { busy: r.claimed === w.outboxBatchSize };
            }, logger),
          );
        }
        if (w.referenceEnabled) {
          workers.push(
            new PeriodicWorker(
              'reference-retry',
              w.referenceIntervalMs,
              referenceRetryTick(store, service, logger, { batchSize: w.referenceBatchSize, leaseMs: w.referenceLeaseMs }, metrics),
              logger,
            ),
          );
        }
        // Amostragem de outbox lag e profundidade da DLQ para as métricas.
        workers.push(
          new PeriodicWorker('metrics-sampler', 5_000, async () => {
            const stats = await outboxStore.stats(new Date());
            metrics.outboxPending.set(stats.pending);
            metrics.outboxLag.set(stats.oldestAgeSeconds);
            const dlq = await sqs.send(
              new GetQueueAttributesCommand({ QueueUrl: urls.dlq, AttributeNames: ['ApproximateNumberOfMessages'] }),
            );
            metrics.dlqDepth.set(Number(dlq.Attributes?.ApproximateNumberOfMessages ?? 0));
            return { busy: false };
          }, logger),
        );
        return workers;
      },
    },
    MessagingLifecycle,
    {
      provide: SQS_READINESS,
      inject: [SQS_CLIENT, QUEUE_URLS],
      useFactory: (sqs: SQSClient, urls: QueueUrls): ReadinessCheck => ({
        name: 'sqs',
        check: async () => {
          await sqs.send(new GetQueueAttributesCommand({ QueueUrl: urls.wager, AttributeNames: ['QueueArn'] }));
        },
      }),
    },
  ];
}
