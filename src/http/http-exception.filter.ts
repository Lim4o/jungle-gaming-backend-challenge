import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import {
  ApplicationError,
  ConflictError,
  NotFoundError,
  TransientInfrastructureError,
  ValidationError,
} from '../application/errors';
import type { AppLogger } from '../application/ports';
import { DomainError } from '../domain/errors';
import { errorFields } from '../observability/logger';
import type { HttpRequest, HttpResponse } from './http-types';

/**
 * Formato único de erro em todos os endpoints:
 *   { "error": { "code", "message", "retryable", "details"? } }
 * `retryable` diz ao provedor se reenviar a mesma requisição é seguro e útil.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const res = http.getResponse<HttpResponse>();
    const { status, code, message, retryable, details } = this.describe(exception);

    const fields = { correlationId: req.correlationId, method: req.method, path: req.url.split('?')[0], status, code };
    if (status >= 500) this.logger.error({ ...fields, ...errorFields(exception) }, 'request failed');
    else this.logger.warn(fields, 'request rejected');

    if (exception instanceof TransientInfrastructureError) res.setHeader('Retry-After', '1');
    res.status(status).json({ error: { code, message, retryable, ...(details ? { details } : {}) } });
  }

  private describe(exception: unknown): {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  } {
    if (exception instanceof ApplicationError) {
      const status =
        exception instanceof ValidationError ? 400
        : exception instanceof NotFoundError ? 404
        : exception instanceof ConflictError ? 409
        : exception instanceof TransientInfrastructureError ? 503
        : 500;
      return {
        status,
        code: exception.code,
        message: exception instanceof TransientInfrastructureError ? 'Service temporarily unavailable' : exception.message,
        retryable: exception.retryable,
        details: exception instanceof TransientInfrastructureError ? undefined : exception.details,
      };
    }
    if (exception instanceof DomainError) {
      return { status: 400, code: exception.code, message: exception.message, retryable: false };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        status === 400 ? 'INVALID_PAYLOAD'
        : status === 401 || status === 403 ? 'UNAUTHORIZED'
        : status === 404 ? 'ROUTE_NOT_FOUND'
        : status === 413 ? 'PAYLOAD_TOO_LARGE'
        : 'HTTP_ERROR';
      return { status, code, message: exception.message, retryable: status >= 500 };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error', retryable: false };
  }
}
