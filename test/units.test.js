import { describe, it, expect } from 'vitest';
import {
  toFeet, fromFeet, sqFtToSqM, fmtFtIn, formatLength, formatArea,
  parseLength, round, snap,
} from '../src/engine/units.js';

describe('units: conversion', () => {
  it('toFeet / fromFeet round-trip across units', () => {
    for (const u of ['ft', 'in', 'm', 'cm', 'mm']) {
      const ft = toFeet(100, u);
      expect(fromFeet(ft, u)).toBeCloseTo(100, 6);
    }
  });
  it('inches and meters convert to the right feet', () => {
    expect(toFeet(12, 'in')).toBeCloseTo(1, 9);
    expect(toFeet(1, 'm')).toBeCloseTo(3.280839895, 6);
  });
  it('unknown unit falls back to feet (no NaN)', () => {
    expect(toFeet(5, 'bogus')).toBe(5);
  });
  it('sqFtToSqM', () => {
    expect(sqFtToSqM(100)).toBeCloseTo(9.290304, 5);
  });
});

describe('units: parseLength', () => {
  it("parses feet-inches with fractions", () => {
    expect(parseLength("12'6\"")).toBeCloseTo(12.5, 9);
    expect(parseLength("12' 6 1/2\"")).toBeCloseTo(12.5417, 3);
    expect(parseLength("0'-3\"")).toBeCloseTo(0.25, 9);
  });
  it('parses explicit metric units', () => {
    expect(parseLength('3.81m')).toBeCloseTo(12.5, 2);
    expect(parseLength('381cm')).toBeCloseTo(12.5, 2);
    expect(parseLength('3810mm')).toBeCloseTo(12.5, 2);
  });
  it('parses explicit imperial units', () => {
    expect(parseLength('150in')).toBeCloseTo(12.5, 6);
    expect(parseLength('12.5ft')).toBeCloseTo(12.5, 9);
  });
  it('bare number respects the default system', () => {
    expect(parseLength('12.5', 'imperial_ft_in')).toBeCloseTo(12.5, 9);
    expect(parseLength('150', 'imperial_in')).toBeCloseTo(12.5, 6);
    expect(parseLength('3.81', 'metric_m')).toBeCloseTo(12.5, 2);
  });
  it('returns null on empty / garbage rather than NaN', () => {
    expect(parseLength('')).toBeNull();
    expect(parseLength(null)).toBeNull();
    expect(parseLength('   ')).toBeNull();
    expect(parseLength('abc')).toBeNull();
  });
});

describe('units: formatting', () => {
  it('fmtFtIn renders dash form', () => {
    expect(fmtFtIn(12.5)).toBe("12'-6\"");
    expect(fmtFtIn(10)).toBe("10'");
  });
  it('fmtFtIn rounds to nearest 1/16 and carries', () => {
    // 0.999 ft is just under 12in -> should carry to the next foot cleanly
    expect(fmtFtIn(0.9999)).toBe("1'");
  });
  it('fmtFtIn handles negative', () => {
    expect(fmtFtIn(-2.5)).toBe("-2'-6\"");
  });
  it('formatLength switches by system', () => {
    expect(formatLength(12.5, 'imperial_decft')).toBe('12.5 ft');
    expect(formatLength(1, 'metric_cm')).toBe('30.5 cm');
    expect(formatLength(1, 'imperial_in')).toBe('12 in');
  });
  it('formatArea metric vs imperial', () => {
    expect(formatArea(100, 'imperial_ft_in')).toBe('100 sf');
    expect(formatArea(100, 'metric_m')).toBe('9.29 m²');
  });
});

describe('units: helpers', () => {
  it('round to n places', () => {
    expect(round(1.23456, 2)).toBe(1.23);
    expect(round(1.005, 2)).toBe(1.01);
  });
  it('snap to increment, and passes through when inc<=0', () => {
    expect(snap(12.3, 0.5)).toBe(12.5);
    expect(snap(12.3, 0)).toBe(12.3);
  });
});
