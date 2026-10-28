import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, type AppModuleOptions } from './app.module';
import { LOGGER, type AppLogger } from './application/ports';
import { HttpExceptionFilter } from './http/http-exception.filter';

/** Monta a aplicação (usado pelo main e pelos testes de integração HTTP). */
export async function createApp(options: AppModuleOptions): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(options), {
    logger: ['error', 'warn'],
    bodyParser: true,
  });
  const logger = app.get<AppLogger>(LOGGER);
  app.useGlobalFilters(new HttpExceptionFilter(logger));
  app.enableShutdownHooks();
  return app;
}
