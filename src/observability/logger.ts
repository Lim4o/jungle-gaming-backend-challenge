import pino from 'pino';
import type { AppLogger } from '../application/ports';

/**
 * Logs JSON estruturados. Campos de rastreio padronizados: correlationId,
 * messageId, transactionId, walletId, providerId. A redação abaixo é rede de
 * segurança: o código já evita logar payloads financeiros e cabeçalhos.
 */
export function createLogger(level: string, instanceId: string): AppLogger {
  const logger = pino({
    level,
    base: { service: 'wagering-processor', instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ['money', 'balance', 'payload', 'body', 'headers', '*.money', '*.balance', '*.payload', '*.authorization'],
      censor: '[redacted]',
    },
  });
  const clean = (fields: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  return {
    info: (f, m) => logger.info(clean(f), m),
    warn: (f, m) => logger.warn(clean(f), m),
    error: (f, m) => logger.error(clean(f), m),
    debug: (f, m) => logger.debug(clean(f), m),
  };
}

export function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  const e = error as Error & { code?: string; sqlState?: string };
  return { errorName: e.name, errorMessage: e.message, errorCode: e.code ?? e.sqlState };
}
