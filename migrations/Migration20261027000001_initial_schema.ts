import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As invariantes financeiras ficam no banco (seção 5, item 9):
 *
 *  - unicidade: wallet por (player, moeda); transação por idempotency key e por
 *    (provider, externalTransactionId); no máximo um lançamento por (transação, wallet);
 *    uma referência só é revertida uma vez; inbox por (consumer, messageId).
 *  - não-negatividade: CHECK em saldo e em balance_before/after do ledger.
 *  - imutabilidade: triggers bloqueiam UPDATE/DELETE/TRUNCATE no ledger e qualquer
 *    alteração em transações que já atingiram estado terminal.
 *  - consistência saldo ↔ ledger: constraint triggers DEFERRED verificam, no COMMIT,
 *    que o saldo da wallet é igual ao balance_after do último lançamento, e cada
 *    lançamento encadeia no anterior (balance_before = balance_after anterior).
 */
export class Migration20261027000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   uuid not null,
        currency    char(3) not null constraint wallets_currency_iso check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(19,2) not null constraint wallets_balance_non_negative check (balance >= 0),
        version     integer not null constraint wallets_version_positive check (version >= 1),
        created_at  timestamptz not null,
        updated_at  timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency)
      );
    `);

    // version incrementa exatamente 1 quando o saldo muda, e só nesse caso.
    this.addSql(`
      create function wallets_guard_update() returns trigger language plpgsql as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
           or new.created_at <> old.created_at then
          raise exception 'wallet % identity is immutable', old.id using errcode = 'WG001';
        end if;
        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'wallet % version must increment by 1 when balance changes', old.id
            using errcode = 'WG002';
        end if;
        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallet % version can only change with balance', old.id
            using errcode = 'WG002';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`create trigger wallets_guard_update before update on wallets
                 for each row execute function wallets_guard_update();`);
    this.addSql(`
      create function forbid_delete() returns trigger language plpgsql as $$
      begin
        raise exception '% rows cannot be deleted', tg_table_name using errcode = 'WG003';
      end $$;
    `);
    this.addSql(`create trigger wallets_forbid_delete before delete on wallets
                 for each row execute function forbid_delete();`);

    // -------------------------------------------------------- wager_transactions
    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        varchar(64)  not null,
        external_transaction_id            varchar(128) not null,
        idempotency_key                    varchar(255) not null,
        payload_hash                       char(64)     not null,
        wallet_id                          uuid not null references wallets(id),
        player_id                          uuid not null,
        round_id                           varchar(128) not null,
        game_id                            varchar(128) not null,
        kind                               varchar(16) not null constraint wtx_kind_valid
          check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                             numeric(19,2) not null,
        currency                           char(3) not null,
        reference_external_transaction_id  varchar(128),
        reference_transaction_id           uuid references wager_transactions(id),
        status                             varchar(24) not null constraint wtx_status_valid
          check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                       varchar(64),
        balance_after                      numeric(19,2),
        attempts                           integer not null default 0 constraint wtx_attempts_non_negative check (attempts >= 0),
        next_attempt_at                    timestamptz,
        created_at                         timestamptz not null,
        updated_at                         timestamptz not null,
        processed_at                       timestamptz,

        constraint wtx_idempotency_key_uq     unique (idempotency_key),
        constraint wtx_provider_external_uq   unique (provider_id, external_transaction_id),
        constraint wtx_amount_valid           check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wtx_reference_required     check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wtx_reference_resolved     check (status <> 'PROCESSED' or kind not in ('REFUND','ROLLBACK') or reference_transaction_id is not null),
        constraint wtx_failure_code_iff_failed check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wtx_processed_at_iff_processed check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wtx_processed_has_balance  check (status <> 'PROCESSED' or balance_after is not null),
        constraint wtx_balance_after_non_negative check (balance_after is null or balance_after >= 0)
      );
    `);

    // Uma transação só pode ser revertida uma vez (REFUND ou ROLLBACK).
    // Ver ARCHITECTURE.md: interpretação mais estrita que a do enunciado,
    // para impedir que um BET receba REFUND e também ROLLBACK (crédito duplo).
    this.addSql(`
      create unique index wtx_single_reversal_uq on wager_transactions (reference_transaction_id)
      where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
    `);
    // Worker de referências pendentes.
    this.addSql(`
      create index wtx_pending_reference_due_idx on wager_transactions (next_attempt_at)
      where status = 'PENDING_REFERENCE';
    `);
    // Ao processar uma transação, acha dependentes que estavam esperando por ela.
    this.addSql(`
      create index wtx_pending_reference_lookup_idx
      on wager_transactions (provider_id, reference_external_transaction_id)
      where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wtx_wallet_idx on wager_transactions (wallet_id);`);

    // Estados terminais são imutáveis; campos de negócio nunca mudam.
    this.addSql(`
      create function wtx_guard_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager transaction % is terminal (%)', old.id, old.status
            using errcode = 'WG004';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
            new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id,
            new.kind, new.amount, new.currency, new.reference_external_transaction_id,
            new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
            old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id,
            old.kind, old.amount, old.currency, old.reference_external_transaction_id,
            old.created_at) then
          raise exception 'wager transaction % business fields are immutable', old.id
            using errcode = 'WG005';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`create trigger wtx_guard_update before update on wager_transactions
                 for each row execute function wtx_guard_update();`);
    this.addSql(`create trigger wtx_forbid_delete before delete on wager_transactions
                 for each row execute function forbid_delete();`);

    // ----------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        seq             bigint generated always as identity,
        wallet_id       uuid not null references wallets(id),
        transaction_id  uuid not null references wager_transactions(id),
        direction       varchar(6) not null constraint ledger_direction_valid check (direction in ('DEBIT','CREDIT')),
        amount          numeric(19,2) not null constraint ledger_amount_positive check (amount > 0),
        currency        char(3) not null,
        balance_before  numeric(19,2) not null constraint ledger_before_non_negative check (balance_before >= 0),
        balance_after   numeric(19,2) not null constraint ledger_after_non_negative check (balance_after >= 0),
        created_at      timestamptz not null,
        constraint ledger_seq_uq unique (seq),
        constraint ledger_one_entry_per_tx_wallet_uq unique (transaction_id, wallet_id),
        constraint ledger_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );
    `);
    // Paginação por cursor estável: (wallet_id, seq).
    this.addSql(`create index ledger_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq);`);

    // Ledger é append-only.
    this.addSql(`
      create function ledger_forbid_change() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only' using errcode = 'WG006';
      end $$;
    `);
    this.addSql(`create trigger ledger_forbid_update_delete before update or delete on wallet_ledger_entries
                 for each row execute function ledger_forbid_change();`);
    this.addSql(`create trigger ledger_forbid_truncate before truncate on wallet_ledger_entries
                 for each statement execute function ledger_forbid_change();`);

    // Encadeamento: o lançamento parte do saldo em que o anterior terminou,
    // e a moeda bate com a da wallet e da transação.
    this.addSql(`
      create function ledger_guard_insert() returns trigger language plpgsql as $$
      declare
        previous_after numeric(19,2);
        wallet_currency char(3);
        tx record;
      begin
        -- FOR UPDATE: serializa inserts no ledger da mesma wallet também no banco,
        -- mesmo que algum caminho de código esqueça de travar a wallet antes.
        select currency into wallet_currency from wallets where id = new.wallet_id for update;
        select wallet_id, currency into tx from wager_transactions where id = new.transaction_id;
        if new.currency <> wallet_currency or new.currency <> tx.currency then
          raise exception 'ledger entry currency mismatch' using errcode = 'WG007';
        end if;
        if tx.wallet_id <> new.wallet_id then
          raise exception 'ledger entry wallet differs from transaction wallet' using errcode = 'WG007';
        end if;
        select balance_after into previous_after from wallet_ledger_entries
          where wallet_id = new.wallet_id order by seq desc limit 1;
        if coalesce(previous_after, 0) <> new.balance_before then
          raise exception 'ledger chain broken for wallet %: expected balance_before %, got %',
            new.wallet_id, coalesce(previous_after, 0), new.balance_before using errcode = 'WG008';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`create trigger ledger_guard_insert before insert on wallet_ledger_entries
                 for each row execute function ledger_guard_insert();`);

    // Saldo materializado == último balance_after do ledger, verificado no COMMIT.
    // DEFERRABLE INITIALLY DEFERRED: dentro da transação a ordem dos comandos
    // (update wallet / insert ledger) é livre; no commit tudo precisa fechar.
    this.addSql(`
      create function assert_wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        target_wallet uuid;
        stored numeric(19,2);
        expected numeric(19,2);
      begin
        if tg_table_name = 'wallets' then
          target_wallet := new.id;
        else
          target_wallet := new.wallet_id;
        end if;
        select balance into stored from wallets where id = target_wallet;
        select balance_after into expected from wallet_ledger_entries
          where wallet_id = target_wallet order by seq desc limit 1;
        if stored <> coalesce(expected, 0) then
          raise exception 'wallet % balance % does not match ledger %',
            target_wallet, stored, coalesce(expected, 0) using errcode = 'WG009';
        end if;
        return null;
      end $$;
    `);
    this.addSql(`create constraint trigger wallets_match_ledger
                 after insert or update on wallets deferrable initially deferred
                 for each row execute function assert_wallet_matches_ledger();`);
    this.addSql(`create constraint trigger ledger_matches_wallet
                 after insert on wallet_ledger_entries deferrable initially deferred
                 for each row execute function assert_wallet_matches_ledger();`);

    // ------------------------------------------------------------------- inbox
    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(64)  not null,
        message_id    varchar(128) not null,
        payload_hash  char(64)     not null,
        received_at   timestamptz  not null,
        processed_at  timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      );
    `);

    // ------------------------------------------------------------------ outbox
    this.addSql(`
      create table outbox_messages (
        id              uuid primary key,
        aggregate_id    uuid not null,
        event_type      varchar(64) not null,
        payload         jsonb not null,
        occurred_at     timestamptz not null,
        attempts        integer not null default 0 constraint outbox_attempts_non_negative check (attempts >= 0),
        next_attempt_at timestamptz not null,
        published_at    timestamptz,
        locked_by       varchar(64),
        locked_until    timestamptz,
        last_error      varchar(512)
      );
    `);
    this.addSql(`
      create index outbox_pending_idx on outbox_messages (next_attempt_at)
      where published_at is null;
    `);
    // Um evento publicado não volta a ficar pendente.
    this.addSql(`
      create function outbox_guard_update() returns trigger language plpgsql as $$
      begin
        if old.published_at is not null then
          raise exception 'outbox message % already published', old.id using errcode = 'WG010';
        end if;
        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
           is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'outbox message % content is immutable', old.id using errcode = 'WG010';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`create trigger outbox_guard_update before update on outbox_messages
                 for each row execute function outbox_guard_update();`);
  }

  override async down(): Promise<void> {
    // Tabelas primeiro (levam seus triggers junto), depois as funções.
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
    this.addSql(`drop function if exists outbox_guard_update();`);
    this.addSql(`drop function if exists assert_wallet_matches_ledger();`);
    this.addSql(`drop function if exists ledger_guard_insert();`);
    this.addSql(`drop function if exists ledger_forbid_change();`);
    this.addSql(`drop function if exists wtx_guard_update();`);
    this.addSql(`drop function if exists wallets_guard_update();`);
    this.addSql(`drop function if exists forbid_delete();`);
  }
}
