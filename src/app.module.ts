import {
  type DynamicModule,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CLOCK, LOGGER, TELEMETRY, WAGERING_STORE, type AppLogger, type Clock, systemClock } from './application/ports';
import { WageringQueries } from './application/wagering-queries';
import { WageringService } from './application/wagering.service';
import { APP_CONFIG, type AppConfig } from './config';
import { ExponentialBackoff } from './domain/retry-policy';
import { AllowAllProviderIdentity, AuthGuard, PROVIDER_IDENTITY } from './http/auth.guard';
import { CorrelationMiddleware } from './http/correlation.middleware';
import { HealthController, READINESS_CHECKS, type ReadinessCheck } from './http/health.controller';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmWageringStore } from './infrastructure/persistence/mikro-orm-wagering.store';
import { createLogger } from './observability/logger';
import { Metrics } from './observability/metrics';

/** Fecha o pool por último: workers e consumidores param antes (beforeApplicationShutdown). */
@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

export interface AppModuleOptions {
  config: AppConfig;
  /** Providers extras (SQS, workers) — registrados pelo módulo de mensageria. */
  extraProviders?: Provider[];
  extraReadinessChecks?: string[];
  clock?: Clock;
}

@Module({})
export class AppModule implements NestModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config } = options;
    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      { provide: CLOCK, useValue: options.clock ?? systemClock },
      { provide: LOGGER, useValue: createLogger(config.logLevel, config.instanceId) },
      { provide: Metrics, useValue: new Metrics() },
      { provide: TELEMETRY, useExisting: Metrics },
      {
        provide: MikroORM,
        useFactory: () =>
          MikroORM.init({
            ...buildOrmConfig({ clientUrl: config.databaseUrl }),
            pool: { min: 0, max: config.databasePoolMax },
          }),
      },
      DatabaseLifecycle,
      {
        provide: WAGERING_STORE,
        inject: [MikroORM],
        useFactory: (orm: MikroORM) => new MikroOrmWageringStore(orm, { lockTimeoutMs: config.lockTimeoutMs }),
      },
      {
        provide: WageringService,
        inject: [WAGERING_STORE, CLOCK, Metrics, LOGGER],
        useFactory: (store, clock: Clock, metrics: Metrics, logger: AppLogger) =>
          new WageringService(store, {
            clock,
            telemetry: metrics,
            logger,
            referenceRetry: new ExponentialBackoff(
              config.referenceRetry.baseDelayMs,
              config.referenceRetry.maxDelayMs,
              config.referenceRetry.maxAttempts,
            ),
          }),
      },
      {
        provide: WageringQueries,
        inject: [WAGERING_STORE, Metrics, LOGGER],
        useFactory: (store, metrics: Metrics, logger: AppLogger) => new WageringQueries(store, metrics, logger),
      },
      { provide: PROVIDER_IDENTITY, useClass: AllowAllProviderIdentity },
      { provide: APP_GUARD, useClass: AuthGuard },
      {
        provide: 'DATABASE_READINESS',
        inject: [MikroORM],
        useFactory: (orm: MikroORM): ReadinessCheck => ({
          name: 'postgres',
          check: async () => {
            await orm.em.fork().execute('select 1');
          },
        }),
      },
      ...(options.extraProviders ?? []),
      {
        provide: READINESS_CHECKS,
        inject: ['DATABASE_READINESS', ...(options.extraReadinessChecks ?? [])],
        useFactory: (...checks: ReadinessCheck[]) => checks,
      },
    ];

    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers,
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
