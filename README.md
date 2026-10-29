# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`,
`LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores, por HTTP e por SQS.
Permanece correto com mensagens duplicadas, fora de ordem, processadas em
paralelo e com várias instâncias.

**Stack:** Bun 1.x · TypeScript estrito · NestJS 11 · PostgreSQL · MikroORM 6 ·
AWS SQS (LocalStack) · Docker Compose.

- Decisões, trade-offs e limitações: **[ARCHITECTURE.md](ARCHITECTURE.md)**
- Teste de carga (metodologia e resultados): **[docs/LOAD_TEST.md](docs/LOAD_TEST.md)**

---

## Requisitos

- [Bun](https://bun.sh) 1.x
- Docker + Docker Compose (Docker Desktop no Windows/macOS)

No Windows, recomenda-se rodar os comandos no **WSL** (os testes multi-instância
usam sinais POSIX, como `SIGTERM`).

## Subindo o ambiente

### Opção A — infraestrutura no Docker, aplicação local (desenvolvimento)

```bash
docker compose up -d            # PostgreSQL (com o banco wagering_test) + LocalStack (filas criadas no init)
cp .env.example .env
bun install
bun run migrate:up
bun run start                   # http://localhost:3000
```

### Opção B — tudo no Docker, com 3 instâncias

```bash
docker compose --profile app up --build
```

Sobe PostgreSQL, LocalStack, um serviço `migrate` (roda as migrations uma vez)
e três instâncias disputando o mesmo banco e as mesmas filas:
`http://localhost:3001`, `:3002` e `:3003`.

### Filas

Criadas pelo `docker/localstack-init.sh`:

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | entrada de transações (consumida pelo serviço) |
| `wager-transactions-dlq.fifo` | DLQ (motivo em `MessageAttributes.failureReason`) |
| `wager-events.fifo` | eventos de integração publicados pela outbox |

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a aplicação (API + consumidor SQS + workers) |
| `bun run migrate:up` | aplica as migrations pendentes |
| `bun run migrate:down` | reverte a última migration |
| `bun run migrate:fresh` | reverte tudo e aplica de novo |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun test` | toda a suíte (precisa do `docker compose up -d`) |
| `bun run test:unit` | só testes de unidade (sem infraestrutura) |
| `bun run test:integration` | integração com PostgreSQL e SQS reais |
| `bun run test:concurrency` | corridas, 50 requisições em paralelo, 3 processos, reinício |
| `bun run test:load` | teste de carga com 3 instâncias (ver `docs/LOAD_TEST.md`) |
| `bun run scripts/send-wager.ts <walletId> <playerId> [kind] [amount] [externalId] [referenceExternalId]` | publica uma transação na fila |

Os testes usam o banco `wagering_test` (criado pelo compose) e criam filas com
nome único por teste. Cada arquivo de integração recria o schema rodando as
migrations `down` e `up`. Variáveis: `TEST_DATABASE_URL`, `TEST_SQS_ENDPOINT`.

## Usando a API

```bash
# Criar wallet (saldo inicial gera OPENING + CREDIT no ledger)
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'
# => 201 {"id":"<walletId>","playerId":"...","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

# Apostar
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' -d '{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "<walletId>",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}'
# => 201 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
# Repetir a mesma requisição => 201 com "idempotentReplay": true (sem novo débito)
```

Para `REFUND`/`ROLLBACK`, inclua `"referenceExternalTransactionId"` com o id do
provedor da transação revertida. Se ela ainda não chegou, a resposta é `202`
com `status: "PENDING_REFERENCE"`, e o worker aplica quando ela chegar.

| Endpoint | Descrição |
|---|---|
| `POST /wallets` | cria wallet |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=...&limit=50` | ledger paginado (cursor opaco; `limit` até 200) |
| `POST /wallets/:walletId/reconciliation` | saldo materializado × soma do ledger |
| `POST /wagering/transactions` | submete transação (`Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET /health/live`, `GET /health/ready` | liveness / readiness (PostgreSQL e SQS) |
| `GET /metrics` | métricas Prometheus |

**Status HTTP:** `201` processada · `202` aguardando referência · `400` payload
inválido · `404` não encontrado · `409` conflito de idempotência · `422`
rejeitada por regra de negócio (com `failureCode` e `action`) · `503`
falha transitória (`retryable: true`, `Retry-After`). Tabela completa e códigos
de falha no [ARCHITECTURE.md](ARCHITECTURE.md#7-regras-de-negócio-e-interpretações-adotadas).

## Usando a fila

```bash
bun run scripts/send-wager.ts <walletId> <playerId> BET 25.00 bet-1
bun run scripts/send-wager.ts <walletId> <playerId> REFUND 25.00 refund-1 bet-1
```

Formato da mensagem (o mesmo contrato da API, com `idempotencyKey` em `data`):

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

## Configuração

Todas as variáveis, com valores padrão, estão em [`.env.example`](.env.example)
(as das instâncias do compose em `docker/app.env`). As principais:

| Variável | Padrão | Para quê |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/wagering` | banco |
| `LOCK_TIMEOUT_MS` | `5000` | espera máxima pelo lock da wallet (depois: 503) |
| `SQS_ENDPOINT` | — | LocalStack (`http://localhost:4566`) |
| `SQS_MAX_RECEIVE_COUNT` | `5` | tentativas antes da DLQ |
| `SQS_CONCURRENCY` | `10` | mensagens em paralelo por instância |
| `REFERENCE_RETRY_MAX_ATTEMPTS` | `12` | limite de espera por referência (~47 min) |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | prazo para terminar mensagens no SIGTERM |

## Estrutura

```
src/
  domain/           Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos, regras (settleWager)
  application/      use cases, portas, validação de comandos, outbox relay
  infrastructure/   persistence/ (MikroORM) e messaging/ (SQS)
  http/             controllers, filtro de erros, guard de autenticação (ponto de extensão)
  workers/          laço periódico, worker de referências pendentes
  observability/    logs JSON e métricas
migrations/         schema com constraints e triggers (versionado e reversível)
scripts/            migrations, envio de mensagem, teste de carga
test/               unit/, integration/, concurrency/, support/
docs/               relatório do teste de carga
```
