import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type HttpRequest, type HttpResponse, header } from './http-types';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Propaga X-Correlation-Id (ou gera um) para logs, eventos e resposta. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: HttpRequest, res: HttpResponse, next: () => void): void {
    const incoming = header(req, 'x-correlation-id');
    req.correlationId = incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader('X-Correlation-Id', req.correlationId);
    next();
  }
}
