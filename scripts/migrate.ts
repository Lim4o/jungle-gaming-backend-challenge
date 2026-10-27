/**
 * bun run migrate:up    -> aplica migrations pendentes
 * bun run migrate:down  -> reverte a última migration
 * bun run migrate:fresh -> reverte tudo e aplica de novo
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';

const command = process.argv[2] ?? 'up';
const orm = await MikroORM.init(buildOrmConfig());
const migrator = orm.getMigrator();

try {
  if (command === 'up') {
    const applied = await migrator.up();
    console.log(`applied: ${applied.map((m) => m.name).join(', ') || '(nothing)'}`);
  } else if (command === 'down') {
    const reverted = await migrator.down();
    console.log(`reverted: ${reverted.map((m) => m.name).join(', ') || '(nothing)'}`);
  } else if (command === 'fresh') {
    await migrator.down({ to: 0 });
    const applied = await migrator.up();
    console.log(`fresh: ${applied.map((m) => m.name).join(', ')}`);
  } else {
    throw new Error(`unknown command ${command}`);
  }
} finally {
  await orm.close(true);
}
