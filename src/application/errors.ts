/**
 * Erros da camada de aplicação. Cada um diz se reenviar a mesma requisição
 * pode dar outro resultado (`retryable`). A borda (HTTP/SQS) traduz:
 *
 *   ValidationError              400  payload inválido          (corrigir)
 *   NotFoundError                404  recurso inexistente       (corrigir)
 *   ConflictError                409  idempotência / duplicado  (corrigir)
 *   TransientInfrastructureError 503  banco/lock/fila           (reenviar)
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;

  protected constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';
  readonly retryable = false;
  constructor(readonly issues: string[]) {
    super(`Invalid payload: ${issues.join('; ')}`, { issues });
  }
}

export class NotFoundError extends ApplicationError {
  readonly retryable = false;
  constructor(override readonly code: string, message: string) {
    super(message);
  }
}

export class ConflictError extends ApplicationError {
  readonly retryable = false;
  constructor(override readonly code: string, message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TEMPORARILY_UNAVAILABLE';
  readonly retryable = true;
  constructor(readonly reason: string, override readonly cause?: unknown) {
    super(`Temporarily unavailable: ${reason}`);
  }
}

export const walletNotFound = (walletId: string) =>
  new NotFoundError('WALLET_NOT_FOUND', `wallet ${walletId} not found`);
