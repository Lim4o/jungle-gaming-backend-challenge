import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { assertUuid, parseCreateWallet } from '../application/commands';
import { ValidationError } from '../application/errors';
import { WageringQueries } from '../application/wagering-queries';
import { WageringService } from '../application/wagering.service';
import type { HttpRequest } from './http-types';
import { ledgerView, reconciliationView, walletView } from './presenters';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(WageringService) private readonly service: WageringService,
    @Inject(WageringQueries) private readonly queries: WageringQueries,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: HttpRequest) {
    const wallet = await this.service.createWallet(parseCreateWallet(body, req.correlationId!));
    return walletView(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return walletView(await this.queries.wallet(assertUuid(walletId, 'walletId')));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (limit !== undefined && !/^\d+$/.test(limit)) throw new ValidationError(['limit must be an integer']);
    return ledgerView(await this.queries.ledger(assertUuid(walletId, 'walletId'), cursor || undefined, parsedLimit));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string, @Req() req: HttpRequest) {
    return reconciliationView(await this.queries.reconcile(assertUuid(walletId, 'walletId'), req.correlationId!));
  }
}
