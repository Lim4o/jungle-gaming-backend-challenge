/**
 * Publica uma WagerTransactionRequested na fila (para testar o consumidor à mão).
 *
 *   bun run scripts/send-wager.ts <walletId> <playerId> [kind] [amount] [externalId] [referenceExternalId]
 *
 * Exemplo:
 *   bun run scripts/send-wager.ts 0192f291-... 0192f28f-... BET 25.00 bet-1
 */
import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/config';
import { createSqsClient } from '../src/infrastructure/messaging/sqs';

const [walletId, playerId, kind = 'BET', amount = '10.00', externalId = `tx-${Date.now()}`, reference] =
  process.argv.slice(2);
if (!walletId || !playerId) {
  console.error('uso: bun run scripts/send-wager.ts <walletId> <playerId> [kind] [amount] [externalId] [referenceExternalId]');
  process.exit(1);
}

const config = loadConfig();
const sqs = createSqsClient(config.aws);
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.sqs.wagerQueue }));
const messageId = `msg-${crypto.randomUUID()}`;
const body = {
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: 'provider-a',
    externalTransactionId: externalId,
    idempotencyKey: `provider-a:${externalId}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  },
};
await sqs.send(
  new SendMessageCommand({
    QueueUrl,
    MessageBody: JSON.stringify(body),
    // Ordem por wallet é otimização; a garantia de consistência é o banco.
    MessageGroupId: walletId,
    MessageDeduplicationId: messageId,
  }),
);
console.log(`enviada ${messageId} (${kind} ${amount} ${externalId})`);
