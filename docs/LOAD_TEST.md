# Teste de carga

`bun run test:load` — script em `scripts/load-test.ts`.

## Metodologia

- Sobe **3 instâncias** da aplicação como processos separados, sobre o mesmo
  PostgreSQL e as mesmas filas SQS (o mesmo arranjo do teste multi-instância).
- Cria 200 wallets "normais" e 1 **hot wallet**, todas com saldo alto (o objetivo
  é medir throughput, não rejeições).
- Dispara `POST /wagering/transactions` com **concorrência fixa** (32 requisições
  simultâneas, round-robin entre as instâncias) durante **20 s**:
  - 20% do tráfego vai para a hot wallet, 80% para wallets aleatórias;
  - mix: 70% `BET`, 20% `WIN`, **10% replays** de requisições já enviadas.
- Durante a carga, amostra o **outbox lag** (idade do evento pendente mais antigo)
  a cada 250 ms. Um consumidor "downstream" lê e apaga a fila de eventos.
- No fim: soma conflitos de lock pelas métricas das 3 instâncias e verifica a
  **invariante saldo == ledger em todas as wallets**.

Variáveis: `LOAD_DURATION_SEC`, `LOAD_CONCURRENCY`, `LOAD_WALLETS`, `LOAD_DRAIN_TIMEOUT_SEC`.

## Ambiente da medição

Container Linux x64 com **2 CPUs**, Bun 1.4.4, PostgreSQL 17 e emulador de SQS
(moto) **na mesma máquina** que as 3 instâncias e o gerador de carga. Ou seja,
tudo disputa os mesmos 2 núcleos — os números abaixo são um piso, não uma
estimativa de produção.

## Resultado

```
Duração / conc.    : 20.4 s, 32 requisições simultâneas
Requisições        : 1856  (91 req/s)
Status HTTP        : 201=1856  rede=0
Taxa de erro       : 0.00%
Latência (ms)      : p50=98.5  p95=1854.8  p99=3271.9  max=9380.3
  hot wallet       : n=322    p50=1208.9  p95=3271.9  p99=5365.4
  wallets normais  : n=1348   p50=83.3    p95=388.6   p99=712.4
  replays          : n=186    p50=40.3    p95=1559.1  p99=3496.9
Replays detectados : 186
Conflitos de lock  : 0
Outbox lag máximo  : 125.78 s (emulador de SQS — ver análise)
Invariante         : OK — 0 wallets divergentes, 1871 lançamentos
```

## Análise

**Correção sob carga.** Zero erros, zero divergência entre saldo e ledger, todos
os 186 replays reconhecidos como replay. É o resultado que importa.

**A hot wallet domina a cauda.** O p50 da hot wallet (1,2 s) é ~15x o das wallets
normais (83 ms). Isso é consequência direta da estratégia: a unidade de
concorrência é a wallet, então todas as requisições da hot wallet fazem fila no
`SELECT ... FOR UPDATE` da mesma linha. Com 20% de 32 requisições simultâneas,
há em média ~6 esperando a vez. O p95 geral (1,8 s) é quase todo hot wallet.
Formas de atacar, se fosse necessário (não implementadas):
- encurtar a seção crítica (hoje ela inclui o insert da transação, do ledger e
  da outbox — tudo precisa ser atômico, então o ganho é limitado);
- sub-wallets / saldo particionado para jogadores de altíssimo volume (complexo:
  a regra "saldo nunca negativo" passa a valer para a soma);
- limitar a concorrência por wallet na borda (fila por wallet na aplicação).

**Replays são baratos.** p50 de 40 ms: o replay é resolvido antes do lock da
wallet (consulta por idempotency key). A cauda alta dos replays acontece quando
o replay chega enquanto a requisição original ainda está esperando o lock —
nesse caso ele também espera, e depois responde com o resultado original.

**Conflitos de lock: 0.** Com `lock_timeout` de 5 s nenhuma requisição desistiu
de esperar. Com mais concorrência na hot wallet, apareceriam 503 retryable
(e a métrica `wallet_lock_conflicts_total` subiria).

**Outbox lag: o gargalo foi o emulador de SQS, não a outbox.** Medido à parte:
o moto fica mais lento a cada mensagem que a fila FIFO já recebeu (verifica
deduplicação de forma linear):

| mensagens já enviadas à fila | vazão do emulador |
|---|---|
| 0     | 306 msg/s |
| 500   | 56 msg/s  |
| 1.000 | 28 msg/s  |
| 2.000 | 15 msg/s  |

A carga gera ~2 eventos por transação (~180 eventos/s), e depois de alguns
milhares de eventos o emulador aceita ~10/s — o lag cresce até a fila esvaziar.
Durante a investigação foi encontrada e corrigida uma ineficiência real na
outbox (marcava cada evento publicado com um `UPDATE` separado; agora é um
`UPDATE` por lote). O docker-compose usa LocalStack, que é outra implementação;
vale repetir a medição lá.

**Throughput absoluto (91 req/s)** é baixo porque 3 instâncias, PostgreSQL,
emulador e gerador dividem 2 núcleos. Não há meta de RPS no desafio; para um
número representativo, rodar com PostgreSQL e LocalStack em máquinas próprias.
