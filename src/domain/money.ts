import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Contrato de entrada/saída: valor sempre como string decimal. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Escala fixa de 2 casas. Internamente o valor é guardado em unidades
 * mínimas (centavos) como `bigint`: aritmética inteira, exata e sem
 * arredondamento. Nunca existe `number` no caminho do dinheiro.
 */
const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);

/** Cabe em NUMERIC(19,2): até 17 dígitos inteiros. */
const MAX_MINOR = 10n ** 19n - 1n;

/**
 * Formato aceito na entrada: inteiro sem zeros à esquerda, com 0 a 2 casas.
 * Rejeita por construção: sinal, notação científica, NaN, Infinity,
 * espaços, string vazia, ".5", "5." e mais de 2 casas decimais.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Entrada externa (API, fila, banco). Não aceita valores negativos. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`malformed amount "${amount}"`);
    }
    return new Money(Money.parseMinor(amount), Money.validCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.validCurrency(currency));
  }

  get amount(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const units = abs / FACTOR;
    const cents = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${units}.${cents}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return Money.ofMinor(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  /** Resultado interno de operações; aqui o sinal negativo é permitido. */
  private static ofMinor(minor: bigint, currency: string): Money {
    if (minor > MAX_MINOR || minor < -MAX_MINOR) {
      throw new InvalidMoneyError('amount out of range');
    }
    return new Money(minor, currency);
  }

  private static parseMinor(amount: string): bigint {
    const [units = '0', fraction = ''] = amount.split('.');
    return BigInt(units) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
  }

  private static validCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`invalid ISO-4217 currency "${String(currency)}"`);
    }
    return currency;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
