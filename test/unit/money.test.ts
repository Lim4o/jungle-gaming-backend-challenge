import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('escala e serialização', () => {
    test('serializa sempre com 2 casas', () => {
      expect(brl('25').amount).toBe('25.00');
      expect(brl('25.5').amount).toBe('25.50');
      expect(brl('25.05').amount).toBe('25.05');
      expect(brl('0').amount).toBe('0.00');
      expect(brl('0.01').toJSON()).toEqual({ amount: '0.01', currency: 'BRL' });
    });

    test('toString inclui a moeda', () => {
      expect(brl('10.10').toString()).toBe('10.10 BRL');
    });

    test('aritmética é exata (sem erro de ponto flutuante)', () => {
      // Em number: 0.1 + 0.2 = 0.30000000000000004
      expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
      let total = Money.zero('BRL');
      for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
      expect(total.amount).toBe('10.00');
    });

    test('suporta o maior valor que cabe em NUMERIC(19,2)', () => {
      expect(brl('99999999999999999.99').amount).toBe('99999999999999999.99');
    });

    test('rejeita overflow em operação', () => {
      expect(() => brl('99999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
    });
  });

  describe('entradas inválidas', () => {
    const invalid = [
      '', ' ', '25.555', '25.001', '1e3', '1E3', '-1', '-0.01', '+1', 'NaN', 'Infinity',
      '-Infinity', '.5', '5.', '0x10', '007', '1,00', ' 10.00', '10.00 ', '1_000',
      '100000000000000000',
    ];
    for (const amount of invalid) {
      test(`rejeita amount "${amount}"`, () => {
        expect(() => brl(amount)).toThrow(InvalidMoneyError);
      });
    }

    test('rejeita amount numérico (contrato exige string)', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    test('rejeita moeda fora do padrão ISO-4217', () => {
      for (const currency of ['', 'brl', 'BR', 'BRLL', '123']) {
        expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
      }
    });

    test('rejeita payload nulo', () => {
      expect(() => Money.from(null as never)).toThrow(InvalidMoneyError);
    });
  });

  describe('operações', () => {
    test('é imutável: operações retornam nova instância', () => {
      const a = brl('10.00');
      const b = a.add(brl('5.00'));
      expect(a.amount).toBe('10.00');
      expect(b.amount).toBe('15.00');
      expect(b).not.toBe(a);
    });

    test('subtract pode produzir negativo (uso interno) e negate inverte', () => {
      const r = brl('10.00').subtract(brl('25.50'));
      expect(r.amount).toBe('-15.50');
      expect(r.isNegative()).toBe(true);
      expect(r.negate().amount).toBe('15.50');
    });

    test('predicados', () => {
      expect(brl('0').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('1').isLessThan(brl('1.01'))).toBe(true);
      expect(brl('1.10').equals(brl('1.1'))).toBe(true);
      expect(brl('1').equals(Money.from({ amount: '1', currency: 'USD' }))).toBe(false);
    });
  });

  describe('conflito de moeda', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    test.each([
      ['add', (m: Money) => m.add(usd)],
      ['subtract', (m: Money) => m.subtract(usd)],
      ['isLessThan', (m: Money) => m.isLessThan(usd)],
    ])('%s entre moedas diferentes lança erro de domínio', (_name, op) => {
      expect(() => op(brl('1.00'))).toThrow(CurrencyMismatchError);
    });
  });
});
