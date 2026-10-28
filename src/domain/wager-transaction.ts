import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-code';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Transições válidas. Estados terminais não aparecem como origem.
 *
 *   PENDING ──────────┬─> PROCESSED
 *                     ├─> REJECTED
 *                     ├─> FAILED
 *                     └─> PENDING_REFERENCE ──┬─> PROCESSED
 *                                             ├─> REJECTED (inclusive REFERENCE_NOT_FOUND)
 *                                             ├─> FAILED
 *                                             └─> PENDING_REFERENCE (nova tentativa agendada)
 */
const TRANSITIONS: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

/** Tipos que cada kind pode referenciar (seção 7, regra 3). */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
};

const REVERSAL_KINDS = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);

export interface CreateWagerTransactionProps {
  id?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends Required<Omit<CreateWagerTransactionProps, 'referenceExternalTransactionId'>> {
  referenceExternalTransactionId?: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
  updatedAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  at: Date;
}

export const INTERNAL_PROVIDER = 'internal';

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _updatedAt: Date,
    private _attempts: number = 0,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    /** Saldo da wallet observado quando a decisão foi tomada (base do replay). */
    private _observedBalance?: Money,
    private _nextAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError(`unknown kind "${String(props.kind)}"`);
    }
    if (props.providerId === INTERNAL_PROVIDER) {
      throw new InvalidWagerTransactionError(`provider "${INTERNAL_PROVIDER}" is reserved`);
    }
    for (const field of ['providerId', 'externalTransactionId', 'idempotencyKey', 'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      const value = props[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidWagerTransactionError(`${field} is required`);
      }
    }
    const isLoss = props.kind === WagerTransactionKind.Loss;
    if (isLoss ? props.money.isNegative() : !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(isLoss ? 'amount cannot be negative' : 'amount must be positive');
    }
    const ref = props.referenceExternalTransactionId;
    if (REVERSAL_KINDS.has(props.kind) && !ref) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (ref !== undefined && !ALLOWED_REFERENCE_KINDS[props.kind]) {
      throw new InvalidWagerTransactionError(`${props.kind} cannot reference another transaction`);
    }
    if (ref === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('a transaction cannot reference itself');
    }
    return WagerTransaction.build(props, props.kind);
  }

  /** Crédito interno de abertura da wallet. Já nasce aplicado. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    const tx = WagerTransaction.build(
      {
        id: props.id,
        providerId: INTERNAL_PROVIDER,
        externalTransactionId: `opening:${props.walletId}`,
        idempotencyKey: `${INTERNAL_PROVIDER}:opening:${props.walletId}`,
        payloadHash: props.payloadHash,
        walletId: props.walletId,
        playerId: props.playerId,
        roundId: 'opening',
        gameId: 'opening',
        money: props.money,
        createdAt: props.at,
      },
      WagerTransactionKind.Opening,
    );
    tx.markProcessed(undefined, props.at, props.money);
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.updatedAt,
      state.attempts,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.nextAttemptAt,
    );
  }

  private static build(
    props: Omit<CreateWagerTransactionProps, 'kind'>,
    kind: WagerTransactionKind,
  ): WagerTransaction {
    return new WagerTransaction(
      props.id ?? crypto.randomUUID(),
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      props.createdAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ------------------------------------------------------------ transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidWagerTransactionError(`${this.kind} cannot be processed without a resolved reference`);
    }
    this.transitionTo(WagerTransactionStatus.Processed, at);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = balanceAfter;
    this._nextAttemptAt = undefined;
  }

  /** Referência ainda não chegou: guarda e agenda a próxima tentativa. */
  markPendingReference(nextAttemptAt: Date, at: Date, observedBalance?: Money): void {
    if (!this.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError('transaction has no reference to wait for');
    }
    const isRetry = this._status === WagerTransactionStatus.PendingReference;
    this.transitionTo(WagerTransactionStatus.PendingReference, at);
    if (isRetry) this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
    if (observedBalance) this._observedBalance = observedBalance;
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.transitionTo(WagerTransactionStatus.Rejected, at);
    this._failureCode = code;
    this._nextAttemptAt = undefined;
    if (observedBalance) this._observedBalance = observedBalance;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed, at);
    this._failureCode = code;
    this._nextAttemptAt = undefined;
  }

  private transitionTo(next: WagerTransactionStatus, at: Date): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this._status, next);
    }
    this._status = next;
    this._updatedAt = at;
  }

  // ------------------------------------------------------- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  isReversal(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * BET debita; WIN, REFUND e OPENING creditam; ROLLBACK faz o inverso da referência.
   * LOSS não move saldo, então pedir a direção dele é erro de programação.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidWagerTransactionError('ROLLBACK direction depends on its reference');
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not affect balance');
    }
  }

  /**
   * Falta de saldo numa aposta e numa reversão são situações operacionais
   * diferentes (seção 7, regra 9), então usam códigos diferentes.
   */
  insufficientFundsCode(): FailureCode {
    return this.kind === WagerTransactionKind.Bet
      ? FailureCode.InsufficientFunds
      : FailureCode.ReversalInsufficientFunds;
  }

  /**
   * Regras 2, 3 e 5 da seção 7. A regra 4 ("revertida uma vez só") depende de
   * consulta e é garantida pelo índice único wtx_single_reversal_uq.
   * Retorna o código de rejeição, ou `undefined` se a referência é válida.
   */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    const sameContext =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameContext) return FailureCode.ReferenceMismatch;

    const allowed = ALLOWED_REFERENCE_KINDS[this.kind] ?? [];
    if (!allowed.includes(reference.kind)) return FailureCode.ReferenceKindNotAllowed;

    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

    if (this.isReversal() && !reference.money.equals(this.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }
    return undefined;
  }

  /** Referência ainda pode chegar (ou ainda está ela mesma aguardando). */
  static isAwaitable(reference: WagerTransaction | undefined): boolean {
    return (
      reference === undefined ||
      reference.status === WagerTransactionStatus.PendingReference ||
      reference.status === WagerTransactionStatus.Pending
    );
  }
}
