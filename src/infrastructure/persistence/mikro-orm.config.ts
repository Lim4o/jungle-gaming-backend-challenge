import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

export function buildOrmConfig(overrides: { clientUrl?: string; entities?: unknown[] } = {}) {
  return defineConfig({
    clientUrl:
      overrides.clientUrl ??
      process.env.DATABASE_URL ??
      'postgres://postgres:postgres@localhost:5432/wagering',
    entities: (overrides.entities ?? []) as never[],
    discovery: { warnWhenNoEntities: false },
    pool: { min: 0, max: Number(process.env.DATABASE_POOL_MAX ?? 20) },
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      path: resolve(root, 'migrations'),
      glob: '!(*.d).{js,ts}',
      transactional: true,
      allOrNothing: true,
      emit: 'ts',
      snapshot: false,
    },
    // Toda escrita passa por transação explícita (em.transactional).
    allowGlobalContext: false,
    debug: false,
  });
}

export default buildOrmConfig();
