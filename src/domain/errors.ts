/**
 * Erros de domínio. Cada um carrega um `code` estável e legível por máquina,
 * que a camada HTTP/SQS usa para decidir o status e se a operação é terminal.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor() {
    super('Insufficient funds');
  }
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
  constructor(reason: string) {
    super(`Invalid ledger entry: ${reason}`);
  }
}

export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';
  constructor(reason: string) {
    super(`Invalid wager transaction: ${reason}`);
  }
}

/**
 * Tentativa de transição a partir de um estado terminal.
 * É erro de programação, não caminho de negócio (seção 6.3).
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(from: string, to: string) {
    super(`Invalid transition from ${from} to ${to}`);
  }
}
