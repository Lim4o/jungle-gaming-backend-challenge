import type { Money } from '../domain/money';
import type { Wallet } from '../domain/wallet';
import type { WagerTransaction } from '../domain/wager-transaction';
import { NotFoundError, ValidationError, walletNotFound } from './errors';
import {
  type AppLogger,
  type LedgerPage,
  type WageringStore,
  type WageringTelemetry,
  noopTelemetry,
  silentLogger,
} from './ports';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export const LEDGER_PAGE_MAX = 200;

export class WageringQueries {
  constructor(
    private readonly store: WageringStore,
    private readonly telemetry: WageringTelemetry = noopTelemetry,
    private readonly logger: AppLogger = silentLogger,
  ) {}

  async wallet(walletId: string): Promise<Wallet> {
    const wallet = await this.store.findWallet(walletId);
    if (!wallet) throw walletNotFound(walletId);
    return wallet;
  }

  async transaction(id: string): Promise<WagerTransaction> {
    const tx = await this.store.findTransactionById(id);
    if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', `transaction ${id} not found`);
    return tx;
  }

  async transactionByExternalId(providerId: string, externalId: string): Promise<WagerTransaction> {
    const tx = await this.store.findTransactionByProviderExternal(providerId, externalId);
    if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', `transaction ${providerId}/${externalId} not found`);
    return tx;
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_PAGE_MAX) {
      throw new ValidationError([`limit must be an integer between 1 and ${LEDGER_PAGE_MAX}`]);
    }
    await this.wallet(walletId);
    return this.store.ledgerPage(walletId, cursor, limit);
  }

  /**
   * Compara o saldo materializado com a soma do ledger. Divergência não é
   * corrigida: é logada, contada em métrica e devolvida na resposta.
   */
  async reconcile(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const totals = await this.store.ledgerTotals(walletId);
    if (!totals) throw walletNotFound(walletId);

    const difference = totals.storedBalance.subtract(totals.calculatedBalance);
    const consistent = difference.isZero();
    this.telemetry.reconciliationChecked(consistent);

    const report = { walletId, ...totals, difference, consistent };
    if (!consistent) {
      this.logger.error(
        {
          correlationId,
          walletId,
          // Só a diferença (necessária para diagnóstico); saldos ficam fora do log.
          difference: difference.amount,
          checkedEntries: totals.checkedEntries,
        },
        'wallet reconciliation divergence',
      );
    }
    return report;
  }
}
