import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { Metrics } from '../observability/metrics';
import { Public } from './auth.guard';
import type { HttpResponse } from './http-types';

export interface ReadinessCheck {
  name: string;
  check(): Promise<void>;
}

export const READINESS_CHECKS = Symbol('ReadinessChecks');

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

@Public()
@Controller()
export class HealthController {
  constructor(
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[],
    @Inject(Metrics) private readonly metrics: Metrics,
  ) {}

  /** Processo vivo: não consulta dependências (evita restart em cascata). */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Pronto para tráfego: PostgreSQL e SQS alcançáveis. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: HttpResponse) {
    const results = await Promise.all(
      this.checks.map(async (c) => {
        try {
          await withTimeout(c.check(), CHECK_TIMEOUT_MS);
          return [c.name, { status: 'up' }] as const;
        } catch (error) {
          return [c.name, { status: 'down', error: (error as Error).message }] as const;
        }
      }),
    );
    const up = results.every(([, r]) => r.status === 'up');
    res.status(up ? 200 : 503);
    return { status: up ? 'ok' : 'unavailable', checks: Object.fromEntries(results) };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metricsEndpoint() {
    return this.metrics.registry.metrics();
  }
}
