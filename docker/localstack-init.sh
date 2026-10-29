#!/bin/bash
# Cria as filas FIFO usadas pelo serviço. A DLQ é ligada à fila principal
# via RedrivePolicy com maxReceiveCount = 6 = limite do consumidor (5) + 1:
# quem manda para a DLQ, com o motivo, é o consumidor; a redrive é rede de segurança.
set -euo pipefail

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"6\\\"}\"}"

# Fila onde o outbox publica os eventos de integração.
awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "SQS queues ready"
