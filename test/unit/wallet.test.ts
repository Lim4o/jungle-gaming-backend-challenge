import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvalidLedgerEntryError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { NOW, PLAYER, WALLET, brl, usd, wallet } from '../support/builders';

/** Saldo reconstruído somando os lançamentos. */
const replay = (entries: WalletLedgerEntry[], currency = 'BRL') =>
  entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero(currency));

describe('Wallet', () => {
  test('abre com version 1 e lançamento OPENING quando saldo > 0', () => {
    const { wallet: w, openingEntry } = Wallet.open({
      id: WALLET, playerId: PLAYER, initialBalance: brl('1000.00'), openingTransactionId: 'tx-open', at: NOW,
    });
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe('1000.00');
    expect(w.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
  });

  test('abre sem lançamento quando saldo inicial é zero', () => {
    const { wallet: w, openingEntry } = Wallet.open({
      id: WALLET, playerId: PLAYER, initialBalance: brl('0'), openingTransactionId: 'x', at: NOW,
    });
    expect(w.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('debit e credit produzem lançamento e incrementam version', () => {
    const w = wallet('100.00');
    const d = w.debit(brl('30.00'), 'tx-1', NOW);
    expect(w.balance.amount).toBe('70.00');
    expect(w.version).toBe(2);
    expect(d.balanceBefore.amount).toBe('100.00');
    expect(d.balanceAfter.amount).toBe('70.00');

    const c = w.credit(brl('5.50'), 'tx-2', NOW);
    expect(w.balance.amount).toBe('75.50');
    expect(w.version).toBe(3);
    expect(c.direction).toBe(LedgerDirection.Credit);
  });

  test('débito pode zerar o saldo, mas não deixá-lo negativo', () => {
    const w = wallet('100.00');
    w.debit(brl('100.00'), 'tx-1', NOW);
    expect(w.balance.isZero()).toBe(true);
    expect(() => w.debit(brl('0.01'), 'tx-2', NOW)).toThrow(InsufficientFundsError);
  });

  test('falha de débito não altera estado (saldo nem version)', () => {
    const w = wallet('10.00');
    expect(() => w.debit(brl('10.01'), 'tx', NOW)).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  test('moeda da operação deve ser a moeda da wallet', () => {
    const w = wallet('100.00');
    expect(() => w.debit(usd('1.00'), 'tx', NOW)).toThrow(CurrencyMismatchError);
    expect(() => w.credit(usd('1.00'), 'tx', NOW)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test('saldo sempre igual ao reconstruído pelo ledger', () => {
    const { wallet: w, openingEntry } = Wallet.open({
      id: WALLET, playerId: PLAYER, initialBalance: brl('50.00'), openingTransactionId: 'o', at: NOW,
    });
    const entries = [openingEntry!];
    entries.push(w.debit(brl('20.00'), 'a', NOW));
    entries.push(w.credit(brl('7.35'), 'b', NOW));
    entries.push(w.debit(brl('37.35'), 'c', NOW));
    expect(w.balance.amount).toBe('0.00');
    expect(replay(entries).equals(w.balance)).toBe(true);
  });

  test('rehydrate reconstrói sem revalidar', () => {
    const w = Wallet.rehydrate({
      id: WALLET, playerId: PLAYER, currency: 'BRL', balance: brl('3.00'), version: 7, createdAt: NOW, updatedAt: NOW,
    });
    expect(w.version).toBe(7);
    expect(w.balance.amount).toBe('3.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = { walletId: WALLET, transactionId: 't', createdAt: NOW };

  test('valida a aritmética na factory', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base, direction: LedgerDirection.Debit, money: brl('10'), balanceBefore: brl('100'), balanceAfter: brl('95'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita valor zero e saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base, direction: LedgerDirection.Credit, money: brl('0'), balanceBefore: brl('1'), balanceAfter: brl('1'),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base, direction: LedgerDirection.Debit, money: brl('2'), balanceBefore: brl('1'), balanceAfter: brl('1').subtract(brl('2')),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('é estruturalmente imutável', () => {
    const e = WalletLedgerEntry.create({
      ...base, direction: LedgerDirection.Credit, money: brl('1'), balanceBefore: brl('0'), balanceAfter: brl('1'),
    });
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as unknown as { direction: string }).direction = 'DEBIT';
    }).toThrow();
    expect(e.isBalanced()).toBe(true);
  });
});
