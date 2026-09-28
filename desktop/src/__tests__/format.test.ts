import { describe, expect, it } from 'vitest';
import { ago, duration, lev, pct, price, tone, usageLevel, usd } from '../format';

describe('format', () => {
  it('formats money with explicit signs and a dash for missing values', () => {
    expect(usd(1234.5)).toBe('$1,234.50');
    expect(usd(-12.345)).toBe('-$12.35');
    expect(usd(5, { sign: true })).toBe('+$5.00');
    expect(usd(null)).toBe('—');
    expect(usd(Number.NaN)).toBe('—');
  });
  it('formats percents, leverage and prices', () => {
    expect(pct(1.234, 1, { sign: true })).toBe('+1.2%');
    expect(lev(3)).toBe('3x');
    expect(lev(2.5)).toBe('2.50x');
    expect(price(65432.1)).toBe('65,432.10');
    expect(price(0.00001234)).toBe('0.00001234');
  });
  it('colors PnL green/red by sign only', () => {
    expect(tone(1)).toBe('pos');
    expect(tone(-1)).toBe('neg');
    expect(tone(0)).toBe('');
    expect(tone(null)).toBe('');
  });
  it('durations and relative times', () => {
    expect(duration(59)).toBe('59s');
    expect(duration(125)).toBe('2m 5s');
    expect(duration(7260)).toBe('2h 1m');
    expect(ago(1000, 61_000)).toBe('1m 0s ago');
    expect(ago(61_000, 1000)).toBe('in 1m 0s');
  });
  it('usage levels, including floor-type limits', () => {
    expect(usageLevel(0.5, 1)).toBe('ok');
    expect(usageLevel(0.8, 1)).toBe('warn');
    expect(usageLevel(1, 1)).toBe('breach');
    expect(usageLevel(null, 1)).toBe('na');
    expect(usageLevel(0.5, 1, true)).toBe('breach');
    expect(usageLevel(1.2, 1, true)).toBe('warn');
    expect(usageLevel(5, 1, true)).toBe('ok');
  });
});
