import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, type AppModuleOptions } from './app.module';
import { LOGGER, type AppLogger } from './application/ports';
import { HttpExceptionFilter } from './http/http-exception.filter';

/**
 * Monta a aplicação (usado pelo main e pelos testes de integração HTTP).
 * Sinais (SIGTERM/SIGINT) são tratados no main.ts, que chama `app.close()`
 * e sai com código 0 — o enableShutdownHooks do Nest re-emitiria o sinal.
 */
export async function createApp(options: AppModuleOptions): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(options), {
    logger: ['error', 'warn'],
    bodyParser: true,
  });
  const logger = app.get<AppLogger>(LOGGER);
  app.useGlobalFilters(new HttpExceptionFilter(logger));
  return app;
}
