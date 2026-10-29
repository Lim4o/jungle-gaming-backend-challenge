# ARCHITECTURE

Decisões, trade-offs e limitações do **Distributed Wagering Processor**.
Setup e comandos estão no [README](README.md); o relatório de carga em
[docs/LOAD_TEST.md](docs/LOAD_TEST.md).

---

## 1. Visão geral

```
 provedores                                       ┌──────────────── 1 transação SQL ────────────────┐
 ─────────▶ POST /wagering/transactions ──┐       │ inbox (se SQS) · wager_transactions ·            │
                                          ├─▶ WageringService.submit ─▶ wallets (FOR UPDATE) ·      │
 ─────────▶ wager-transactions.fifo ──────┘       │ wallet_ledger_entries · outbox_messages          │
            (WagerConsumer)                       └──────────────────────────────────────────────────┘
                                                                     │ commit
                                                                     ▼
                                   OutboxRelay (todas as instâncias) ──▶ wager-events.fifo
                                   ReferenceRetryWorker  ──▶ reprocessa PENDING_REFERENCE
```

- **HTTP e SQS chamam o mesmo use case** (`WageringService.submit`). A única
  diferença é que a entrada por fila registra o inbox na mesma transação SQL.
- **O banco é a fonte da verdade.** Unicidade, imutabilidade, não-negatividade e
  a consistência saldo ↔ ledger estão no schema (seção 5). Ordem e
  deduplicação do SQS FIFO são otimizações.
- **Nenhum estado em memória é garantia de nada.** Toda instância é
  intercambiável; qualquer uma pode morrer a qualquer momento.

### Camadas

```
src/domain/          regras puras: Money, Wallet, WagerTransaction, ledger, inbox/outbox,
                     eventos, settleWager(). Sem NestJS, sem ORM, sem I/O.
src/application/     use cases (WageringService, WageringQueries, OutboxRelay),
                     portas (WageringStore, OutboxStore, EventPublisher, Clock, Telemetry),
                     validação de comandos, erros de aplicação.
src/infrastructure/  adaptadores: MikroORM (persistence/) e SQS (messaging/).
src/http/            controllers NestJS, filtro de erros, guard de autenticação.
src/workers/         laço periódico e worker de referências pendentes.
src/observability/   logger (pino) e métricas (prom-client).
```

As dependências apontam para dentro: `domain` não importa nada de fora;
`application` depende só de `domain` e das próprias portas; adaptadores
implementam as portas. Isso permite testar todas as regras de negócio
(`settleWager`) sem banco, e trocar o broker ou o ORM sem tocar no domínio.

---

## 2. Modelo de domínio

### Money

- Valor guardado como **`bigint` em centavos** (escala fixa 2). Toda aritmética
  é inteira e exata; `number` não aparece em nenhum caminho de dinheiro.
- Entrada validada por regex `^(0|[1-9]\d{0,16})(\.\d{1,2})?$`, que rejeita por
  construção: `NaN`, `Infinity`, notação científica, sinal, string vazia, zeros à
  esquerda, `.5`, `5.` e mais de 2 casas. Valores numéricos (não string) também
  são rejeitados.
- Nunca arredonda: mais de 2 casas é erro, não arredondamento silencioso.
- Imutável; operações entre moedas diferentes lançam `CurrencyMismatchError`.
  `subtract`/`negate` podem gerar negativo internamente (ex.: diferença da
  reconciliação), mas `Money.from` só aceita não-negativos.
- Limite de 17 dígitos inteiros = cabe em `NUMERIC(19,2)`.
- *Alternativa descartada:* `decimal.js`. Com escala fixa, `bigint` nativo é
  mais simples, sem dependência e sem modos de arredondamento para errar.

### Wallet (aggregate root)

- O saldo só muda por `debit`/`credit`, e ambos **devolvem o lançamento do
  ledger**: não existe caminho que altere saldo sem produzir ledger.
- `version` começa em 1 e incrementa **só quando o saldo muda** (garantido
  também por trigger).
- Uma operação que falha (saldo insuficiente, moeda errada) não altera nada.

### WagerTransaction e transições

```
PENDING ──────────┬─▶ PROCESSED   (terminal)
                  ├─▶ REJECTED    (terminal, failureCode)
                  ├─▶ FAILED      (terminal, failureCode)
                  └─▶ PENDING_REFERENCE ──┬─▶ PROCESSED | REJECTED | FAILED
                                          └─▶ PENDING_REFERENCE (nova tentativa)
```

Transição a partir de estado terminal lança `InvalidTransactionStateError`
(erro de programação). No banco, um trigger impede qualquer UPDATE em linha
terminal e qualquer mudança em campos de negócio.

Na prática `PENDING` é um estado transitório em memória: a transação é decidida
dentro da mesma transação SQL em que é inserida, então só são gravados estados
finais ou `PENDING_REFERENCE`.

### settleWager — regras de negócio puras

`src/domain/wager-settlement.ts` recebe wallet (já travada), transação e
referência e decide tudo: débito, crédito, rejeição ou espera pela referência.
Devolve o lançamento e os eventos para o chamador persistir. Por ser puro, as
regras de `BET/WIN/LOSS/REFUND/ROLLBACK` têm testes de unidade rápidos
(`test/unit/wager-settlement.test.ts`).

### Ledger, Inbox, Outbox

- `WalletLedgerEntry`: todos os campos `readonly`, objeto congelado
  (`Object.freeze`), `create` valida `balanceBefore ± money === balanceAfter`.
- `InboxMessage`: chave `(consumerName, messageId)`.
- `OutboxMessage`: `id` = `eventId`; `scheduleRetry` aplica backoff;
  `markPublished` é irreversível.
- Eventos: classe abstrata `IntegrationEvent<T>` com uma subclasse por evento;
  `eventType` e `version` ficam no tipo. `data` carrega `MoneyProps` (string),
  nunca a instância de `Money`.

---

## 3. ORM e persistência

**MikroORM** (a opção preferencial), usado com:

- `em.transactional()` em toda escrita, com isolamento `READ COMMITTED`;
- `LockMode.PESSIMISTIC_WRITE` para travar a wallet (`SELECT ... FOR UPDATE`);
- `EntitySchema` (sem decorators) em `persistence/records.ts`: as classes de
  domínio não conhecem o ORM. `mappers.ts` converte registro ↔ domínio usando
  as factories `rehydrate`;
- `disableIdentityMap` nas leituras dentro da transação: cada consulta reflete
  o banco, nunca um cache do Identity Map (importante quando a mesma linha é
  relida depois de esperar um lock);
- migrations versionadas e reversíveis (`up`/`down`), transacionais.

**Mapeamento de Money:** coluna `NUMERIC(19,2)` + coluna `currency CHAR(3)`.
O tipo `decimal` do MikroORM devolve **string** (`"25.00"`), que vira `Money`
via `Money.from`, sem passar por `number`.

**SQL explícito onde importa:** os inserts que podem colidir (transação e inbox)
usam `INSERT ... ON CONFLICT DO NOTHING RETURNING 1`, montado a partir dos
metadados do ORM. Diferente de capturar a exceção de chave única, isso **não
aborta a transação SQL**, então o use case pode, na mesma transação, ler a
linha vencedora e devolver o replay. O claim da outbox e das referências
pendentes também é SQL explícito (`UPDATE ... WHERE id IN (SELECT ... FOR
UPDATE SKIP LOCKED)`), que o ORM não expressa bem.

`lock_timeout` é definido por transação (`SET LOCAL`, padrão 5 s): quem não
consegue o lock da wallet nesse prazo recebe 503 retryable, em vez de ocupar
uma conexão indefinidamente.

---

## 4. Schema: garantias no banco

`migrations/Migration20261027000001_initial_schema.ts`. Testado com SQL cru em
`test/integration/schema-constraints.test.ts`, sem passar pela aplicação.

| Garantia | Como |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` na wallet e em `balance_before/after` do ledger |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| No máximo um lançamento por transação/wallet | `UNIQUE (transaction_id, wallet_id)` |
| Referência revertida uma única vez | índice único parcial `(reference_transaction_id) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Aritmética do lançamento | `CHECK` (`after = before ± amount` conforme a direção) |
| Ledger append-only | trigger bloqueia `UPDATE`, `DELETE` e `TRUNCATE` |
| Ledger encadeado | trigger: `balance_before` = `balance_after` do lançamento anterior da wallet; moeda e wallet batem com a transação |
| **Saldo == ledger** | *constraint trigger* `DEFERRABLE INITIALLY DEFERRED`: no **COMMIT**, o saldo da wallet tem que ser igual ao `balance_after` do último lançamento. Mudar saldo sem lançar no ledger faz o commit falhar |
| `version` só muda com saldo | trigger (+1 exato quando o saldo muda; inalterada caso contrário) |
| Estados terminais imutáveis | trigger em `wager_transactions` |
| Coerência de estado | `CHECK`s: `failure_code` sse REJECTED/FAILED; `processed_at` sse PROCESSED; REFUND/ROLLBACK exigem referência; PROCESSED de reversão exige referência resolvida; valor > 0 (0 só em LOSS) |
| Inbox | `PRIMARY KEY (consumer_name, message_id)` |
| Outbox | evento publicado não volta a pendente; conteúdo imutável (trigger) |
| Wallets e transações não são excluídas | trigger |

A `seq` do ledger é uma *identity* global e monotônica: base do cursor estável
de paginação.

---

## 5. Concorrência

**Unidade de concorrência: a wallet.** Toda operação que mexe em saldo começa
com `SELECT ... FOR UPDATE` na linha da wallet. Isso serializa, em qualquer
instância, tudo o que toca aquele saldo, e só aquele saldo: wallets diferentes
não disputam lock nenhum (sem lock global).

**Por que pessimista e não otimista.** Numa hot wallet, com optimistic locking
as requisições concorrentes falham na verificação de `version` e entram em
retry, que falha de novo: trabalho desperdiçado que cresce com a carga. Com o
lock pessimista elas esperam na fila do PostgreSQL e cada uma é processada uma
única vez. O custo é a latência da hot wallet (medido em
[docs/LOAD_TEST.md](docs/LOAD_TEST.md)). Mesmo assim o `UPDATE` do saldo é
condicionado à `version` lida (`WHERE id = ? AND version = ?`) como defesa em
profundidade, e o trigger de encadeamento do ledger também trava a wallet.

**Sem deadlock.** Cada transação trava no máximo uma wallet, e sempre antes de
qualquer linha de transação. O worker de referências segue a mesma ordem
(wallet → transação). O claim de pendentes não trava wallet.

**Sem `read → calculate → update` desprotegido.** O cálculo acontece com a
linha travada, e o resultado ainda passa pelos `CHECK`s e triggers no banco.

### Um bug de isolamento encontrado pelos testes

O teste "mesma aposta 50 vezes em paralelo" falhava ~1 em 3 execuções com um
**409 falso**. Causa: em `READ COMMITTED` cada comando SQL enxerga um snapshot
novo. O código consultava primeiro por idempotency key (nada), e logo depois
por `(provider, externalId)`. Entre as duas consultas a requisição vencedora
fazia commit, e a segunda achava a transação: o código concluía "mesmo id
externo sob outra key" e devolvia conflito.

Correção: uma **única consulta** com `OR` (`findTransactionsByIdentity`), um
único snapshot. Depois disso, 15 execuções seguidas sem falha. A lição está
documentada no código (`ports.ts`).

---

## 6. Idempotência

- `Idempotency-Key` (header HTTP, ou `data.idempotencyKey` na fila) é a fonte da
  verdade. Default recomendado: `{providerId}:{externalTransactionId}`.
- **payloadHash** = SHA-256 (hex) do **JSON canônico** dos campos de negócio:
  `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind,
  money, referenceExternalTransactionId`. Canonicalização: chaves em ordem
  lexicográfica, recursiva, sem espaços, `undefined` omitido. O valor passa por
  `Money` antes, então `"25"` e `"25.00"` geram o mesmo hash. Header e
  metadados de transporte ficam fora.
- Mesma key + mesmo hash → **replay**: mesma resposta (status e corpo), com
  `idempotentReplay: true`, inclusive o saldo observado naquele momento
  (guardado em `balance_after` da transação).
- Mesma key + hash diferente → **409 `IDEMPOTENCY_KEY_REUSED`**, nunca replay.
- Mesmo `(providerId, externalTransactionId)` sob outra key → **409
  `EXTERNAL_TRANSACTION_ID_REUSED`**.

Três camadas, nesta ordem:
1. consulta antes do lock da wallet: replay rápido, sem fila;
2. consulta de novo depois do lock: quem esperou enxerga o commit de quem
   chegou antes;
3. índices únicos + `ON CONFLICT DO NOTHING`: a garantia final, mesmo para
   requisições com a mesma key apontando para wallets diferentes.

Nada disso depende de memória.

---

## 7. Regras de negócio e interpretações adotadas

Implementadas conforme a seção 7 do desafio. Interpretações adicionais:

1. **Uma referência só pode ser revertida uma vez, por qualquer tipo.** O
   enunciado diz "pelo mesmo tipo de operação", o que permitiria um `BET`
   receber `REFUND` **e** `ROLLBACK`: crédito duplo. Optei pela regra mais
   estrita (índice único parcial). A segunda reversão é rejeitada com
   `REFERENCE_ALREADY_REVERSED`.
2. **`WIN` e `LOSS` podem referenciar a `BET` da rodada** (opcional). Se
   referenciarem, valem as mesmas validações de contexto e o mesmo fluxo de
   referência pendente. `BET` não pode ter referência.
3. **`LOSS` aceita valor zero** (é só registro do resultado); os demais tipos
   exigem valor > 0.
4. **Referência que existe mas não está `PROCESSED`** (foi rejeitada ou falhou):
   `REFERENCE_NOT_PROCESSED`. Se ela mesma estiver `PENDING_REFERENCE`, a
   reversão também espera.
5. **Wallet inexistente não é gravada**: não há wallet para a FK nem saldo para
   registrar. A API responde 404; um reenvio depois que a wallet existir é
   processado normalmente.
6. **Saldo inicial zero** cria a wallet sem transação `OPENING` e sem ledger.
7. **Reversão sem saldo** (ex.: `ROLLBACK` de um `WIN` já gasto) é rejeitada com
   `REVERSAL_INSUFFICIENT_FUNDS`, distinto do `INSUFFICIENT_FUNDS` de aposta.
8. **Provider `internal` é reservado** para a transação `OPENING`.

### Códigos de falha (`src/domain/failure-code.ts`)

Cada código vem com uma `action` na resposta, para o provedor decidir sem
interpretar mensagem:

| failureCode | Quando | action |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo | `GIVE_UP` |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão deixaria saldo negativo | `GIVE_UP` |
| `CURRENCY_MISMATCH` | moeda ≠ moeda da wallet | `FIX_PAYLOAD` |
| `WALLET_PLAYER_MISMATCH` | wallet de outro player | `FIX_PAYLOAD` |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite (7.1) | `GIVE_UP` |
| `REFERENCE_MISMATCH` | referência de outro provider/player/wallet/moeda/rodada | `FIX_PAYLOAD` |
| `REFERENCE_KIND_NOT_ALLOWED` | ex.: REFUND de um WIN | `FIX_PAYLOAD` |
| `REFERENCE_NOT_PROCESSED` | referência rejeitada ou falhou | `GIVE_UP` |
| `REFERENCE_AMOUNT_MISMATCH` | valor ≠ valor da referência | `FIX_PAYLOAD` |
| `REFERENCE_ALREADY_REVERSED` | referência já revertida | `GIVE_UP` |
| `PERMANENT_PROCESSING_ERROR` | estado `FAILED`: erro inesperado no worker | `GIVE_UP` |

### Status HTTP

Iguais em todos os endpoints; o replay devolve o mesmo status da resposta
original. Erros têm sempre o formato
`{ "error": { "code", "message", "retryable", "details"? } }`.

| Situação | Status | `retryable` |
|---|---|---|
| Processada | **201** | — |
| Aceita, aguardando referência | **202** | — |
| Payload inválido (inclui JSON quebrado, sem Idempotency-Key, `OPENING`) | **400** | false |
| Wallet/transação inexistente | **404** | false |
| Conflito de idempotência / wallet duplicada | **409** | false |
| Rejeitada por regra de negócio (`failureCode` no corpo) | **422** | — |
| Falha transitória (lock timeout, banco/fila fora) | **503** + `Retry-After` | true |

---

## 8. Referências fora de ordem (7.1)

- Referência ausente → `PENDING_REFERENCE` + evento
  `WagerTransactionPendingReference`, com `nextAttemptAt` agendado.
- **Worker agendado** (todas as instâncias): faz o claim das vencidas com
  `FOR UPDATE SKIP LOCKED` e empurra `next_attempt_at` para frente (*lease* de
  30 s). Duas instâncias nunca pegam a mesma; se a instância morrer, a linha
  volta a vencer quando o lease expira.
- **Backoff exponencial:** 2 s, 4 s, 8 s … limitado a 10 min, **12 tentativas**
  (2.822 s, ~47 min no total). Justificativa: provedores costumam mandar a
  operação original em segundos; esperar muito mais só atrasa a resposta
  definitiva ao provedor. Configurável (`REFERENCE_RETRY_*`).
- **Atalho:** quando uma transação é processada, as que esperavam por ela
  (mesmo provider, mesmo `referenceExternalTransactionId`, mesma wallet) têm
  `next_attempt_at` antecipado para agora: na prática a reversão é aplicada em
  ~1 s, sem esperar o backoff.
- Esgotado o limite: `REJECTED` com `REFERENCE_NOT_FOUND` e evento
  `WagerTransactionRejected`.
- Erro inesperado (não transitório) ao reprocessar: a transação vira `FAILED`
  com `PERMANENT_PROCESSING_ERROR` (auditável), em vez de ficar em loop.

---

## 9. Processamento por SQS

`src/infrastructure/messaging/wager-consumer.ts`

- **Mesmo use case** da entrada HTTP; o inbox `(consumerName, messageId)` é
  gravado na mesma transação SQL da mudança financeira.
- **`ack` (DeleteMessage) só depois do commit.** Se o processo morrer entre o
  commit e o ack, a mensagem volta após o visibility timeout e o inbox
  transforma o reprocessamento em replay. Testado.
- **Classificação de erros:**
  - *negócio* (rejeição, conflito de idempotência, wallet inexistente):
    terminal → **ack**;
  - *transitório* (`TransientInfrastructureError`, erros inesperados): nova
    tentativa via `ChangeMessageVisibility` com backoff (1 s, 2 s, … até 60 s);
    ao atingir `SQS_MAX_RECEIVE_COUNT` (5) → **DLQ** com motivo
    `retries_exhausted`/`unexpected_error`;
  - *permanente* (JSON quebrado, tipo desconhecido, payload inválido):
    **DLQ imediata**, sem gastar tentativas.
  A mensagem na DLQ leva o motivo em `MessageAttributes.failureReason`. A fila
  principal também tem `RedrivePolicy` (limite + 1) como rede de segurança.
- **Ordem:** `MessageGroupId = walletId`. Dentro de um lote, mensagens do mesmo
  grupo são processadas em sequência; grupos diferentes em paralelo
  (`SQS_CONCURRENCY`). É otimização: duplicatas em grupos diferentes, ou
  entregues a instâncias diferentes, continuam corretas pelo banco (testado).
- **SIGTERM:** o consumidor para de buscar (aborta o long poll), termina as
  mensagens em andamento até `SHUTDOWN_TIMEOUT_MS` e devolve imediatamente
  (`VisibilityTimeout = 0`) as recebidas que ainda não começaram. Depois param
  os workers, fecha o HTTP e por último o pool do banco. O processo sai com
  código 0 (o `main.ts` trata o sinal; o `enableShutdownHooks` do Nest
  re-emitiria o sinal e o processo terminaria "morto por sinal").

---

## 10. Transactional Outbox

- Eventos são gravados em `outbox_messages` **na mesma transação SQL** da
  mudança financeira. Nada é publicado antes do commit.
- **OutboxRelay** roda em todas as instâncias. Cada tick faz o claim de um lote
  (`UPDATE ... SET locked_by, locked_until WHERE id IN (SELECT ... FOR UPDATE
  SKIP LOCKED)`), publica com `SendMessageBatch` e marca o lote publicado num
  único `UPDATE` condicionado ao dono do lease.
- **Garantia: at-least-once.** Cenário da seção 11: commit feito, processo morre
  antes de publicar → o lease expira → outra instância publica. Se morrer
  *depois* de publicar e antes de marcar, o evento sai de novo **com o mesmo
  `eventId`**: consumidores deduplicam por `eventId` (e o SQS FIFO deduplica
  pelo `MessageDeduplicationId = eventId` dentro da janela de 5 min). Testado.
- Falha de publicação: `attempts + 1`, backoff (1 s … 5 min) e `last_error`;
  sem limite de tentativas: evento confirmado não se perde.
- `MessageGroupId = aggregateId` mantém a ordem por agregado. Entre agregados
  não há ordem global; para ordenar mudanças de saldo o consumidor usa
  `walletVersion` do `WalletBalanceChanged`.
- Eventos: `WagerTransactionProcessed` (inclusive LOSS),
  `WagerTransactionRejected`, `WalletBalanceChanged` (somente quando o saldo
  muda, inclusive na abertura), `WagerTransactionPendingReference`.

---

## 11. Observabilidade

- **Logs JSON** (pino) com `correlationId`, `messageId`, `transactionId`,
  `walletId`, `providerId`, `instanceId`. Sem payloads financeiros: valores e
  saldos não são logados (a reconciliação loga só a diferença), com `redact`
  como rede de segurança. `X-Correlation-Id` é aceito ou gerado e devolvido.
- **Métricas** em `GET /metrics` (Prometheus):

| Métrica | Cobre |
|---|---|
| `wager_transactions_total{status,kind,source}` | transações por status |
| `wager_duplicates_total{kind}` | replays, conflitos de idempotência, duplicatas de inbox |
| `wager_retries_total{component}` | retries de referência, SQS e outbox |
| `wager_dlq_messages_total{reason}`, `wager_dlq_depth` | DLQ |
| `wallet_lock_conflicts_total{reason}` | lock_timeout, deadlock |
| `outbox_pending_messages`, `outbox_lag_seconds`, `outbox_published_total` | outbox lag |
| `wager_processing_duration_seconds{source}` | latência de processamento |
| `wallet_reconciliations_total{consistent}` | divergências de reconciliação |

- **Health:** `GET /health/live` (processo vivo, sem tocar dependências, para
  não reiniciar em cascata) e `GET /health/ready` (PostgreSQL e SQS alcançáveis,
  timeout de 2 s por checagem; 503 se algum falhar). Ambos abertos.
- **Reconciliação** (`POST /wallets/:id/reconciliation`): compara o saldo
  materializado com a soma do ledger. Divergência não é corrigida: é logada
  (nível error), contada em métrica e sinalizada na resposta.

---

## 12. Autenticação (não implementada)

Decisão consciente, já que autenticação não vale pontos e competiria com
correção, concorrência e idempotência.

- **Ponto de extensão no código:** `src/http/auth.guard.ts`. Um `AuthGuard`
  global já está registrado e delega para `ProviderIdentityPort`; a
  implementação atual (`AllowAllProviderIdentity`) aceita tudo. Rotas de health
  e métricas são marcadas com `@Public()`.
- **Desenho previsto:** Keycloak no docker-compose, um client por provedor com
  `client_credentials`. O guard valida o JWT (JWKS do realm, `iss`, `aud`,
  expiração), e o `ProviderIdentityPort` devolve o `providerId` a partir de uma
  claim (`azp`). O use case passa a exigir `command.providerId ===
  identidade`, então um provedor não consegue operar transações de outro.
- Mensagens da fila são tratadas como canal interno confiável, mas o
  `providerId` delas continua sujeito às mesmas validações de domínio
  (referência do mesmo provider etc.).

---

## 13. Testes

167 testes, todos contra **PostgreSQL e SQS reais**; nada é mock do banco ou da fila.

| Exigência (seção 13) | Onde |
|---|---|
| Money, Wallet, regras de BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, key com payload divergente | `test/unit/*` |
| Migrations e constraints | `test/integration/schema-constraints.test.ts` (migrations rodam `down` até 0 e `up` a cada arquivo) |
| Atomicidade wallet/ledger/inbox/outbox | `wagering-service.test.ts` (falha forçada na outbox desfaz tudo) |
| Inbox e redelivery, retry e DLQ, publishers concorrentes, crash do publisher | `messaging.test.ts` |
| 50 requisições idênticas em paralelo, corrida 100 − 80 − 80, wallets distintas em paralelo, hot wallet | `test/concurrency/wallet-race.test.ts` |
| ≥ 3 processos, instância morta com SIGKILL, reinício do serviço | `test/concurrency/multi-instance.test.ts` (3 processos `bun run src/main.ts`) |
| Worker morto depois do commit e antes do ack | `messaging.test.ts` |
| ROLLBACK/REFUND antes da referência | `wagering-service.test.ts`, `messaging.test.ts`, `multi-instance.test.ts` |
| API: status HTTP, 503 com lock preso, paginação, reconciliação | `http-api.test.ts` |

**Invariante final** (`expectLedgerConsistent`): todo arquivo de integração e
concorrência verifica, ao terminar, `saldo == soma do ledger` para **todas** as
wallets do banco.

Testes de concorrência usam paralelismo real: cada requisição em conexão
própria do pool (até 60), ou processos separados.

---

## 14. Limitações e trade-offs conhecidos

- **Hot wallet** serializa no lock: latência alta sob muita concorrência na
  mesma wallet (ver relatório de carga). É o preço da correção simples; as
  alternativas (saldo particionado, fila por wallet na aplicação) estão
  discutidas em `docs/LOAD_TEST.md`.
- **Ledger de partida simples**, não double-entry (diferencial opcional não
  feito). A transação `OPENING` faz o papel da contrapartida do saldo inicial.
- **Reconciliação** confere a soma; o encadeamento lançamento a lançamento já é
  garantido no insert por trigger, então não é refeito na reconciliação.
- **`correlationId` no worker de referências** é o id da transação: o
  `correlationId` da requisição original não é persistido.
- **Estado `FAILED`** não publica evento próprio (não está entre os eventos
  mínimos); é visível por consulta, log e métrica.
- **Redrive da DLQ** é manual (não há endpoint para reprocessar).
- **Ambiente de teste:** os testes foram desenvolvidos contra o emulador moto
  (SQS) e PostgreSQL 17; o docker-compose usa LocalStack e PostgreSQL 16. O
  emulador moto degrada com o volume de mensagens (medido no relatório de
  carga), o que limitou o teste de carga, não a aplicação.
- **Windows:** o teste multi-instância envia `SIGTERM` para processos filhos;
  no Windows nativo sinais não existem do mesmo jeito. Rodar a suíte no Linux,
  macOS ou WSL.
- **Multi-moeda:** o modelo é multi-moeda e conflitos de moeda são testados,
  mas todo o fluxo foi exercitado com BRL.
