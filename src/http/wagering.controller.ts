import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { assertUuid, parseSubmitWager } from '../application/commands';
import { WageringQueries } from '../application/wagering-queries';
import { WageringService } from '../application/wagering.service';
import { type HttpRequest, type HttpResponse, header } from './http-types';
import { httpStatusFor, submitView, transactionView } from './presenters';

@Controller()
export class WageringController {
  constructor(
    @Inject(WageringService) private readonly service: WageringService,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
  ) {}

  /**
   * 201 PROCESSED · 202 PENDING_REFERENCE · 422 REJECTED (regra de negócio)
   * 400 payload inválido · 404 wallet inexistente · 409 conflito de idempotência
   * 503 falha transitória (reenviar com a mesma Idempotency-Key)
   * Replay devolve o mesmo status e corpo, com `idempotentReplay: true`.
   */
  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const command = parseSubmitWager(body, {
      idempotencyKey: header(req, 'idempotency-key'),
      correlationId: req.correlationId!,
    });
    const result = await this.service.submit(command);
    res.status(httpStatusFor(result.transaction));
    return submitView(result);
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string) {
    return transactionView(await this.queries.transaction(assertUuid(transactionId, 'transactionId')));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return transactionView(await this.queries.transactionByExternalId(providerId, externalTransactionId));
  }
}
