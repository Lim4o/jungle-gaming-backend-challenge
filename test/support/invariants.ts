import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';

/**
 * Invariante final de todos os testes (seção 13):
 *   wallet.balance == saldo reconstruído pelo ledger
 * Verificada para TODAS as wallets do banco.
 */
export async function expectLedgerConsistent(orm: MikroORM): Promise<void> {
  const rows = await orm.em.fork().execute<{ id: string; balance: string; calculated: string }[]>(
    `select w.id, w.balance::text as balance,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(21,2)::text as calculated
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      group by w.id`,
  );
  const divergent = rows.filter((r) => r.balance !== r.calculated);
  expect(divergent).toEqual([]);
}

export async function count(orm: MikroORM, sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await orm.em.fork().execute<{ n: string }[]>(`select count(*)::text as n from (${sql}) q`, params);
  return Number(row!.n);
}
