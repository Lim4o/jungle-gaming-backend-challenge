import { InvalidMoneyError } from '../domain/errors';
import { Money, type MoneyProps } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';
import { ValidationError } from './errors';

/** Origem do pedido via fila: entra no inbox na mesma transação SQL. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  causationId?: string;
  inbox?: InboxContext;
}

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Tipos que provedores podem enviar; OPENING é interno. */
const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = Object.values(WagerTransactionKind).filter(
  (k) => k !== WagerTransactionKind.Opening,
);

class Checker {
  readonly issues: string[] = [];

  constructor(private readonly body: Record<string, unknown>) {}

  string(field: string, max: number, opts: { optional?: boolean; pattern?: RegExp } = {}): string | undefined {
    const value = this.body[field];
    if (value === undefined || value === null) {
      if (!opts.optional) this.issues.push(`${field} is required`);
      return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      this.issues.push(`${field} must be a non-empty string`);
      return undefined;
    }
    if (value.length > max) this.issues.push(`${field} must have at most ${max} characters`);
    if (opts.pattern && !opts.pattern.test(value)) this.issues.push(`${field} has an invalid format`);
    return value;
  }

  uuid(field: string): string | undefined {
    return this.string(field, 36, { pattern: UUID })?.toLowerCase();
  }

  money(field: string): Money | undefined {
    const value = this.body[field];
    if (value === undefined || value === null) {
      this.issues.push(`${field} is required`);
      return undefined;
    }
    try {
      return Money.from(value as MoneyProps);
    } catch (error) {
      if (error instanceof InvalidMoneyError) {
        this.issues.push(`${field}: ${error.message}`);
        return undefined;
      }
      throw error;
    }
  }

  done(): void {
    if (this.issues.length > 0) throw new ValidationError(this.issues);
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError(['body must be a JSON object']);
  }
  return body as Record<string, unknown>;
}

/** Valida os campos de negócio de uma transação (mesmo contrato para HTTP e SQS). */
export function parseSubmitWager(
  rawBody: unknown,
  meta: { idempotencyKey: unknown; correlationId: string; causationId?: string; inbox?: InboxContext },
): SubmitWagerCommand {
  const body = asObject(rawBody);
  const c = new Checker({ ...body, idempotencyKey: meta.idempotencyKey });

  const idempotencyKey = c.string('idempotencyKey', 255);
  const providerId = c.string('providerId', 64);
  const externalTransactionId = c.string('externalTransactionId', 128);
  const playerId = c.uuid('playerId');
  const walletId = c.uuid('walletId');
  const roundId = c.string('roundId', 128);
  const gameId = c.string('gameId', 128);
  const referenceExternalTransactionId = c.string('referenceExternalTransactionId', 128, { optional: true });
  const money = c.money('money');

  const kind = body.kind;
  if (typeof kind !== 'string' || !SUBMITTABLE_KINDS.includes(kind as WagerTransactionKind)) {
    c.issues.push(`kind must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
  }
  c.done();

  return {
    idempotencyKey: idempotencyKey!,
    providerId: providerId!,
    externalTransactionId: externalTransactionId!,
    playerId: playerId!,
    walletId: walletId!,
    roundId: roundId!,
    gameId: gameId!,
    kind: kind as WagerTransactionKind,
    money: money!,
    referenceExternalTransactionId,
    correlationId: meta.correlationId,
    causationId: meta.causationId,
    inbox: meta.inbox,
  };
}

export function parseCreateWallet(rawBody: unknown, correlationId: string): CreateWalletCommand {
  const c = new Checker(asObject(rawBody));
  const playerId = c.uuid('playerId');
  const initialBalance = c.money('initialBalance');
  c.done();
  return { playerId: playerId!, initialBalance: initialBalance!, correlationId };
}

export function assertUuid(value: string, field: string): string {
  if (!UUID.test(value)) throw new ValidationError([`${field} must be a UUID`]);
  return value.toLowerCase();
}
