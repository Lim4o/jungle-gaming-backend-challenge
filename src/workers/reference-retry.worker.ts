import { TransientInfrastructureError } from '../application/errors';
import type { AppLogger, WageringStore } from '../application/ports';
import type { WageringService } from '../application/wagering.service';
import { errorFields } from '../observability/logger';
import type { Metrics } from '../observability/metrics';

export interface ReferenceRetryOptions {
  batchSize: number;
  leaseMs: number;
}

/**
 * Worker agendado da seção 7.1. Cada tick "aluga" as PENDING_REFERENCE
 * vencidas (SKIP LOCKED + lease) e reprocessa uma a uma pelo mesmo use case.
 *  - falha transitória: nada muda; o lease expira e a linha volta a vencer;
 *  - erro inesperado: a transação vira FAILED (auditável), não fica em loop.
 */
export function referenceRetryTick(
  store: WageringStore,
  service: WageringService,
  logger: AppLogger,
  options: ReferenceRetryOptions,
  metrics?: Metrics,
) {
  return async (): Promise<{ busy: boolean }> => {
    const candidates = await store.claimDuePendingReferences(new Date(), options.batchSize, options.leaseMs);
    for (const candidate of candidates) {
      try {
        const result = await service.retryPendingReference(candidate);
        if (result === 'rescheduled') metrics?.retry('reference');
      } catch (error) {
        if (error instanceof TransientInfrastructureError) {
          logger.warn({ transactionId: candidate.transactionId, ...errorFields(error) }, 'reference retry postponed');
          continue;
        }
        logger.error({ transactionId: candidate.transactionId, ...errorFields(error) }, 'reference retry crashed');
        await service
          .failPendingReference(candidate, (error as Error).message ?? 'unknown')
          .catch((e) => logger.error({ transactionId: candidate.transactionId, ...errorFields(e) }, 'could not mark FAILED'));
      }
    }
    return { busy: candidates.length === options.batchSize };
  };
}
