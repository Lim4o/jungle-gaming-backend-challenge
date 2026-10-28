/**
 * Taxonomia de falhas, estável e legível por máquina.
 *
 * Cada código diz ao provedor o que fazer:
 *  - FIX_PAYLOAD: o pedido está errado; reenviar igual dá o mesmo resultado.
 *  - GIVE_UP:     regra de negócio; a decisão é final para essa transação.
 *  - RETRY:       infraestrutura; reenviar a mesma requisição (mesma key) é seguro.
 */
export enum FailureCode {
  // ---- saldo
  /** BET sem saldo suficiente. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** REFUND/ROLLBACK que deixaria o saldo negativo (ex.: rollback de WIN já gasto). */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',

  // ---- wallet
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',

  // ---- referência
  /** Referência não chegou dentro do limite de tentativas (seção 7.1). */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência de outro player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo de referência não permitido (ex.: REFUND de um WIN). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Referência existe mas não está PROCESSED (foi rejeitada ou falhou). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Valor da reversão diferente do valor da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** A referência já foi revertida. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',

  // ---- infraestrutura (estado FAILED)
  /** Erro permanente fora das regras de negócio; auditável. */
  PermanentProcessingError = 'PERMANENT_PROCESSING_ERROR',
}

export type FailureAction = 'FIX_PAYLOAD' | 'GIVE_UP' | 'RETRY';

export const FAILURE_ACTION: Record<FailureCode, FailureAction> = {
  [FailureCode.InsufficientFunds]: 'GIVE_UP',
  [FailureCode.ReversalInsufficientFunds]: 'GIVE_UP',
  [FailureCode.WalletNotFound]: 'FIX_PAYLOAD',
  [FailureCode.WalletPlayerMismatch]: 'FIX_PAYLOAD',
  [FailureCode.CurrencyMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotFound]: 'GIVE_UP',
  [FailureCode.ReferenceMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceKindNotAllowed]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotProcessed]: 'GIVE_UP',
  [FailureCode.ReferenceAmountMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceAlreadyReversed]: 'GIVE_UP',
  [FailureCode.PermanentProcessingError]: 'GIVE_UP',
};
