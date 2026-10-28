import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config';

export function createSqsClient(aws: AppConfig['aws']): SQSClient {
  return new SQSClient({
    region: aws.region,
    endpoint: aws.endpoint,
    credentials: { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey },
    // O SDK já faz retry de erros de rede; deixamos curto para o nosso backoff decidir.
    maxAttempts: 2,
  });
}

export interface QueueUrls {
  wager: string;
  dlq: string;
  events: string;
}

export async function resolveQueueUrls(client: SQSClient, sqs: AppConfig['sqs']): Promise<QueueUrls> {
  const url = async (QueueName: string) => {
    const r = await client.send(new GetQueueUrlCommand({ QueueName }));
    if (!r.QueueUrl) throw new Error(`queue ${QueueName} not found`);
    return r.QueueUrl;
  };
  const [wager, dlq, events] = await Promise.all([url(sqs.wagerQueue), url(sqs.wagerDlq), url(sqs.eventsQueue)]);
  return { wager, dlq, events };
}

/**
 * Cria as filas (idempotente). Em ambiente local quem faz isso é o script de
 * init do LocalStack; aqui serve para testes e para subir sem o compose.
 */
export async function ensureQueues(client: SQSClient, sqs: AppConfig['sqs']): Promise<QueueUrls> {
  const dlq = await client.send(
    new CreateQueueCommand({ QueueName: sqs.wagerDlq, Attributes: { FifoQueue: 'true' } }),
  );
  const dlqArn = (
    await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes?.QueueArn;
  const wager = await client.send(
    new CreateQueueCommand({
      QueueName: sqs.wagerQueue,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: String(sqs.visibilityTimeoutSec),
        // Rede de segurança: se o processo morrer em loop, o próprio SQS manda
        // para a DLQ depois de (nosso limite + 1) recebimentos.
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: sqs.maxReceiveCount + 1 }),
      },
    }),
  );
  const events = await client.send(
    new CreateQueueCommand({ QueueName: sqs.eventsQueue, Attributes: { FifoQueue: 'true' } }),
  );
  return { wager: wager.QueueUrl!, dlq: dlq.QueueUrl!, events: events.QueueUrl! };
}
