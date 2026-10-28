import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';

/**
 * Publica envelopes da outbox na fila FIFO de eventos.
 *  - MessageGroupId = aggregateId: ordem por wallet/transação;
 *  - MessageDeduplicationId = eventId: republicações dentro da janela de 5 min
 *    são descartadas pelo próprio SQS (otimização — a garantia é o eventId).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<PublishResult> {
    const result: PublishResult = { published: [], failed: [] };
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      let response;
      try {
        response = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: chunk.map((m, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(m.payload),
            MessageGroupId: m.aggregateId,
            MessageDeduplicationId: m.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: m.eventType },
              eventId: { DataType: 'String', StringValue: m.id },
            },
          })),
        }),
        );
      } catch (error) {
        // Lote inteiro falhou; os lotes anteriores continuam contando como publicados.
        const reason = (error as Error).message ?? String(error);
        for (const m of chunk) result.failed.push({ id: m.id, error: reason });
        continue;
      }
      for (const ok of response.Successful ?? []) result.published.push(chunk[Number(ok.Id)]!.id);
      for (const ko of response.Failed ?? []) {
        result.failed.push({ id: chunk[Number(ko.Id)]!.id, error: `${ko.Code}: ${ko.Message ?? ''}` });
      }
    }
    return result;
  }
}
