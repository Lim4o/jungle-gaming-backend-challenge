import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ConflictError, NotFoundError, TransientInfrastructureError, ValidationError } from '../../application/errors';
import type { AppLogger } from '../../application/ports';
import type { SubmitWagerResult } from '../../application/wagering.service';
import type { SubmitWagerCommand } from '../../application/commands';
import { ExponentialBackoff } from '../../domain/retry-policy';
import { errorFields } from '../../observability/logger';
import type { Metrics } from '../../observability/metrics';
import { PermanentMessageError, parseWagerMessage } from './wager-message';

export interface WagerConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  /** Mensagens processadas ao mesmo tempo (grupos FIFO diferentes). */
  concurrency: number;
  /** Recebimentos permitidos antes de mandar para a DLQ. */
  maxReceiveCount: number;
  visibilityTimeoutSec: number;
  waitTimeSec: number;
  /** Atraso antes de uma nova tentativa (via visibilidade da mensagem). */
  retryBackoff?: ExponentialBackoff;
}

export interface WagerSubmitter {
  submit(command: SubmitWagerCommand): Promise<SubmitWagerResult>;
}

type Outcome = 'acked' | 'retry' | 'dlq' | 'released';

/**
 * Consumidor da fila wager-transactions.fifo.
 *
 * Classificação de erros:
 *  - negócio (rejeição, conflito de idempotência, wallet inexistente): terminal -> ack
 *  - transitório (banco/lock/rede): nova tentativa com backoff, até o limite -> DLQ
 *  - permanente (payload inválido, JSON quebrado): DLQ imediata
 *
 * `ack` (DeleteMessage) só acontece depois que `submit` retornou, ou seja,
 * depois do COMMIT. Se o processo morrer entre o commit e o ack, a mensagem
 * volta e o inbox persistente transforma o reprocessamento em replay.
 */
export class WagerConsumer {
  private running = false;
  private loop?: Promise<void>;
  private poll?: AbortController;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly backoff: ExponentialBackoff;

  constructor(
    private readonly sqs: SQSClient,
    private readonly service: WagerSubmitter,
    private readonly logger: AppLogger,
    private readonly options: WagerConsumerOptions,
    private readonly metrics?: Metrics,
  ) {
    this.backoff = options.retryBackoff ?? new ExponentialBackoff(1_000, 60_000, Number.MAX_SAFE_INTEGER);
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info({ consumer: this.options.consumerName }, 'sqs consumer started');
  }

  /**
   * SIGTERM: para de buscar, termina o que já está em andamento (até o prazo)
   * e devolve a visibilidade do que foi recebido mas não começou.
   */
  async stop(timeoutMs: number): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.poll?.abort();
    await this.loop;
    const pending = [...this.inFlight];
    const timedOut = await Promise.race([
      Promise.allSettled(pending).then(() => false),
      Bun.sleep(timeoutMs).then(() => true),
    ]);
    this.logger.info(
      { consumer: this.options.consumerName, inFlight: pending.length, timedOut },
      'sqs consumer stopped',
    );
  }

  private async run(): Promise<void> {
    while (this.running) {
      const capacity = this.options.concurrency - this.inFlight.size;
      if (capacity <= 0) {
        await Promise.race(this.inFlight);
        continue;
      }
      let messages: Message[];
      try {
        this.poll = new AbortController();
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.options.queueUrl,
            MaxNumberOfMessages: Math.min(10, capacity),
            WaitTimeSeconds: this.options.waitTimeSec,
            VisibilityTimeout: this.options.visibilityTimeoutSec,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.poll.signal },
        );
        messages = response.Messages ?? [];
      } catch (error) {
        if (!this.running) break;
        this.logger.warn({ ...errorFields(error) }, 'sqs receive failed; backing off');
        await Bun.sleep(1_000);
        continue;
      }
      if (messages.length === 0) continue;
      if (!this.running) {
        await Promise.all(messages.map((m) => this.release(m)));
        break;
      }
      // Dentro do lote, mensagens do mesmo grupo (wallet) seguem em ordem;
      // grupos diferentes rodam em paralelo.
      for (const group of groupByMessageGroup(messages)) {
        this.track(this.processGroup(group));
      }
    }
  }

  private track(p: Promise<unknown>): void {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }

  private async processGroup(messages: Message[]): Promise<void> {
    for (const message of messages) {
      if (!this.running) {
        await this.release(message);
        continue;
      }
      await this.handle(message);
    }
  }

  /** Processa uma mensagem. Exposto para testes de falha. */
  async handle(message: Message): Promise<Outcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const base = { sqsMessageId: message.MessageId, receiveCount };

    let parsed;
    try {
      parsed = parseWagerMessage(message.Body, this.options.consumerName);
    } catch (error) {
      if (error instanceof PermanentMessageError) return this.toDlq(message, error.reason, base);
      throw error;
    }
    const fields = {
      ...base,
      messageId: parsed.messageId,
      correlationId: parsed.command.correlationId,
      walletId: parsed.command.walletId,
      providerId: parsed.command.providerId,
    };

    try {
      const result = await this.service.submit(parsed.command);
      // Commit feito: agora sim confirma a mensagem.
      await this.ack(message, { ...fields, transactionId: result.transaction.id });
      return 'acked';
    } catch (error) {
      if (error instanceof ConflictError || error instanceof NotFoundError) {
        // Regra de negócio: reprocessar dá o mesmo resultado. Terminal.
        this.logger.warn({ ...fields, code: error.code }, 'wager message rejected by business rule');
        await this.ack(message, fields);
        return 'acked';
      }
      if (error instanceof ValidationError) {
        return this.toDlq(message, 'invalid_payload', fields);
      }
      const transient = error instanceof TransientInfrastructureError;
      if (receiveCount >= this.options.maxReceiveCount) {
        return this.toDlq(message, transient ? 'retries_exhausted' : 'unexpected_error', {
          ...fields,
          ...errorFields(error),
        });
      }
      return this.retryLater(message, receiveCount, { ...fields, ...errorFields(error) });
    }
  }

  /** Separado para que testes possam simular a morte do processo antes do ack. */
  protected async ack(message: Message, fields: Record<string, unknown>): Promise<void> {
    try {
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
      this.logger.debug(fields, 'wager message acked');
    } catch (error) {
      // O efeito já foi confirmado; a mensagem vai voltar e virar replay pelo inbox.
      this.logger.warn({ ...fields, ...errorFields(error) }, 'ack failed after commit; redelivery will be deduplicated');
    }
  }

  private async retryLater(message: Message, receiveCount: number, fields: Record<string, unknown>): Promise<Outcome> {
    const delaySec = Math.max(1, Math.ceil(this.backoff.delayFor(receiveCount - 1) / 1000));
    this.metrics?.retry('sqs');
    this.logger.warn({ ...fields, retryInSeconds: delaySec }, 'wager message will be retried');
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delaySec,
        }),
      );
    } catch (error) {
      // Sem mudar a visibilidade, a mensagem volta no timeout padrão. Também serve.
      this.logger.warn({ ...fields, ...errorFields(error) }, 'could not set retry visibility');
    }
    return 'retry';
  }

  private async toDlq(message: Message, reason: string, fields: Record<string, unknown>): Promise<Outcome> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.options.dlqUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            failureReason: { DataType: 'String', StringValue: reason },
            receiveCount: { DataType: 'Number', StringValue: String(fields.receiveCount ?? 1) },
          },
        }),
      );
    } catch (error) {
      // Não conseguiu mover: deixa a mensagem voltar e tenta de novo depois.
      this.logger.error({ ...fields, ...errorFields(error) }, 'could not move message to DLQ');
      return 'retry';
    }
    this.metrics?.dlqMessages.inc({ reason });
    this.logger.error({ ...fields, reason }, 'wager message moved to DLQ');
    await this.ack(message, fields);
    return 'dlq';
  }

  private async release(message: Message): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
    } catch (error) {
      this.logger.warn({ sqsMessageId: message.MessageId, ...errorFields(error) }, 'could not release message');
    }
  }
}

function groupByMessageGroup(messages: Message[]): Message[][] {
  const groups = new Map<string, Message[]>();
  for (const m of messages) {
    const key = m.Attributes?.MessageGroupId ?? m.MessageId ?? '';
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  return [...groups.values()];
}
