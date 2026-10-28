import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type AppConfig, loadConfig } from '../../src/config';
import { createSqsClient, ensureQueues, type QueueUrls } from '../../src/infrastructure/messaging/sqs';

export const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566';

/** Filas com nome único por teste: nenhum teste enxerga mensagens de outro. */
export async function createTestQueues(maxReceiveCount = 3): Promise<{ sqs: SQSClient; urls: QueueUrls; config: AppConfig['sqs'] }> {
  const base = loadConfig();
  const prefix = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const config: AppConfig['sqs'] = {
    ...base.sqs,
    wagerQueue: `${prefix}-wager.fifo`,
    wagerDlq: `${prefix}-wager-dlq.fifo`,
    eventsQueue: `${prefix}-events.fifo`,
    maxReceiveCount,
    visibilityTimeoutSec: 1,
    waitTimeSec: 1,
  };
  const sqs = createSqsClient({ ...base.aws, endpoint: SQS_ENDPOINT });
  const urls = await ensureQueues(sqs, config);
  return { sqs, urls, config };
}

export function wagerMessage(data: Record<string, unknown>, messageId = `msg-${crypto.randomUUID()}`) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { idempotencyKey: `${data.providerId}:${data.externalTransactionId}`, ...data },
  };
}

export async function send(sqs: SQSClient, queueUrl: string, body: unknown, group = 'g'): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: group,
      // Dedup id aleatório: simula redelivery/duplicata que o FIFO NÃO pegou.
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}

/** Lê e apaga tudo que estiver visível na fila. */
export async function drain(sqs: SQSClient, queueUrl: string, waitSec = 1): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const r = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSec,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    const batch = r.Messages ?? [];
    if (batch.length === 0) return all;
    all.push(...batch);
    await Promise.all(
      batch.map((m) => sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }))),
    );
  }
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await Bun.sleep(stepMs);
  }
}
