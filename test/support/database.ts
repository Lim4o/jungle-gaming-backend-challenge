import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/wagering_test';

/** Banco real, migrations aplicadas do zero (down até 0, depois up). */
export async function createTestOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(buildOrmConfig({ clientUrl: TEST_DATABASE_URL }));
  const migrator = orm.getMigrator();
  await migrator.down({ to: 0 });
  await migrator.up();
  return orm;
}

export const uuid = () => Bun.randomUUIDv7();

/** Extrai o SQLSTATE de um erro do driver (MikroORM embrulha o erro do pg). */
export function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; sqlState?: string; cause?: { code?: string } };
  return e?.sqlState ?? e?.code ?? e?.cause?.code;
}

export async function expectSqlState(run: () => Promise<unknown>, expected: string): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error(`expected SQLSTATE ${expected}, but nothing was thrown`);
  const state = sqlState(caught);
  if (state !== expected) {
    throw new Error(`expected SQLSTATE ${expected}, got ${state}: ${(caught as Error).message}`);
  }
}
