/**
 * Backoff exponencial determinístico: base * 2^attempt, limitado a `maxDelayMs`.
 * Sem jitter de propósito: o espalhamento entre instâncias já vem do
 * `FOR UPDATE SKIP LOCKED` dos workers, e o determinismo deixa os testes estáveis.
 */
export class ExponentialBackoff {
  constructor(
    public readonly baseDelayMs: number,
    public readonly maxDelayMs: number,
    public readonly maxAttempts: number,
  ) {
    if (baseDelayMs <= 0 || maxDelayMs < baseDelayMs || maxAttempts < 1) {
      throw new Error('invalid backoff configuration');
    }
  }

  delayFor(attempt: number): number {
    const exp = Math.min(attempt, 30);
    return Math.min(this.baseDelayMs * 2 ** exp, this.maxDelayMs);
  }

  nextAttemptAt(attempt: number, now: Date): Date {
    return new Date(now.getTime() + this.delayFor(attempt));
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }
}

/**
 * Referências fora de ordem (seção 7.1): 2s, 4s, 8s ... até 10 min entre
 * tentativas, no máximo 12 tentativas (2+4+...+512 s + 3x600 s = 2.822 s, ~47 min no total). Reversões de
 * provedores costumam chegar em segundos; esperar mais que isso só segura
 * a resposta definitiva para o provedor. Configurável por variável de ambiente.
 */
export const DEFAULT_REFERENCE_RETRY = new ExponentialBackoff(2_000, 600_000, 12);

/** Outbox: 1s, 2s, 4s ... até 5 min. Sem limite de tentativas: evento confirmado não se perde. */
export const DEFAULT_OUTBOX_RETRY = new ExponentialBackoff(1_000, 300_000, Number.MAX_SAFE_INTEGER);
