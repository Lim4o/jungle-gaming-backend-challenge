import { ApplicationError, TransientInfrastructureError } from '../../application/errors';
import { DomainError } from '../../domain/errors';

/**
 * SQLSTATEs que indicam falha passageira: reenviar a mesma requisição é seguro
 * e pode dar certo. Todo o resto é erro permanente (bug, constraint violada).
 */
const TRANSIENT_SQLSTATES: Record<string, string> = {
  '55P03': 'lock_timeout',
  '40P01': 'deadlock',
  '40001': 'serialization_failure',
  '57P01': 'admin_shutdown',
  '57P02': 'crash_shutdown',
  '57P03': 'cannot_connect_now',
  '53300': 'too_many_connections',
  '57014': 'query_canceled',
};

const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

export function databaseErrorCode(error: unknown): string | undefined {
  const e = error as { sqlState?: string; code?: string; cause?: { code?: string } } | undefined;
  return e?.sqlState ?? e?.code ?? e?.cause?.code;
}

export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof ApplicationError || error instanceof DomainError) return error;
  const code = databaseErrorCode(error);
  if (code && TRANSIENT_SQLSTATES[code]) {
    return new TransientInfrastructureError(TRANSIENT_SQLSTATES[code], error);
  }
  if (code && (code.startsWith('08') || TRANSIENT_NODE_CODES.has(code))) {
    return new TransientInfrastructureError('database_unavailable', error);
  }
  const message = (error as Error | undefined)?.message ?? '';
  if (/Connection terminated|timeout exceeded when trying to connect|connect ECONNREFUSED/i.test(message)) {
    return new TransientInfrastructureError('database_unavailable', error);
  }
  return error;
}
