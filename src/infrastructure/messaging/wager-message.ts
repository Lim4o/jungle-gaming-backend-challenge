import { type SubmitWagerCommand, parseSubmitWager } from '../../application/commands';
import { ValidationError } from '../../application/errors';
import { sha256 } from '../../domain/payload-hash';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/**
 * Mensagem que não tem como dar certo, não importa quantas vezes seja
 * reprocessada (JSON quebrado, tipo desconhecido, payload inválido).
 * Vai direto para a DLQ, sem gastar tentativas.
 */
export class PermanentMessageError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentMessageError';
  }
}

export interface ParsedWagerMessage {
  messageId: string;
  command: SubmitWagerCommand;
}

/**
 * Envelope:
 * { messageId, type: "WagerTransactionRequested", occurredAt, correlationId?, data: {...} }
 * `data` usa exatamente o contrato da API HTTP, com `idempotencyKey` no lugar do header.
 */
export function parseWagerMessage(rawBody: string | undefined, consumerName: string): ParsedWagerMessage {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody ?? '') as Record<string, unknown>;
  } catch {
    throw new PermanentMessageError('malformed_json', 'message body is not valid JSON');
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new PermanentMessageError('malformed_envelope', 'message body must be a JSON object');
  }
  const { messageId, type, data } = envelope;
  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 128) {
    throw new PermanentMessageError('malformed_envelope', 'messageId is required (1..128 chars)');
  }
  if (type !== WAGER_MESSAGE_TYPE) {
    throw new PermanentMessageError('unknown_type', `unsupported message type ${String(type)}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new PermanentMessageError('malformed_envelope', 'data must be an object');
  }
  const correlationId =
    typeof envelope.correlationId === 'string' && envelope.correlationId.length <= 128
      ? envelope.correlationId
      : messageId;

  try {
    const command = parseSubmitWager(data, {
      idempotencyKey: (data as Record<string, unknown>).idempotencyKey,
      correlationId,
      causationId: messageId,
      inbox: { consumerName, messageId, payloadHash: sha256(rawBody ?? '') },
    });
    return { messageId, command };
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new PermanentMessageError('invalid_payload', error.message);
    }
    throw error;
  }
}
