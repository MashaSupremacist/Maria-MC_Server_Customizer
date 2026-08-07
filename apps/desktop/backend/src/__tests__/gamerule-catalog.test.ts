import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  gamerulesForVersion,
  parseMcVersion,
} from '../gamerule-catalog';

describe('gamerule catalog', () => {
  it('parses versions into comparable tuples', () => {
    expect(parseMcVersion('1.21.4')).toEqual([1, 21, 4]);
    expect(parseMcVersion('26.2')).toEqual([26, 2]);
    expect(parseMcVersion('')).toEqual([0]);
  });

  it('compares versions correctly', () => {
    expect(compareVersions('1.21.4', '1.21.4')).toBe(0);
    expect(compareVersions('1.21.4', '1.21.5')).toBeLessThan(0);
    expect(compareVersions('1.21.9', '1.22')).toBeLessThan(0);
    expect(compareVersions('26.2', '1.21')).toBeGreaterThan(0);
  });

  it('filters rules by version availability', () => {
    const oldRules = gamerulesForVersion('1.8');
    const newRules = gamerulesForVersion('1.21');
    expect(oldRules.every((r) => r.key !== 'doWardenSpawning')).toBe(true);
    expect(newRules.some((r) => r.key === 'doWardenSpawning')).toBe(true);
  });

  it('returns all rules for an unknown version', () => {
    const all = gamerulesForVersion(null);
    expect(all.length).toBeGreaterThan(25);
  });
});
