import { describe, expect, it } from 'vitest';
import { EventDeduper, RateGate, withBoundary } from '../src/slack/app.js';

describe('EventDeduper', () => {
  it('passes first occurrence, blocks duplicates', () => {
    const d = new EventDeduper();
    expect(d.firstTime('Ev1')).toBe(true);
    expect(d.firstTime('Ev1')).toBe(false);
    expect(d.firstTime('Ev2')).toBe(true);
  });

  it('lets undefined ids through (cannot dedupe)', () => {
    const d = new EventDeduper();
    expect(d.firstTime(undefined)).toBe(true);
    expect(d.firstTime(undefined)).toBe(true);
  });

  it('evicts oldest beyond capacity', () => {
    const d = new EventDeduper(2);
    d.firstTime('a');
    d.firstTime('b');
    d.firstTime('c'); // evicts 'a'
    expect(d.firstTime('a')).toBe(true);
  });
});

describe('RateGate', () => {
  it('spaces calls per key by the minimum interval', async () => {
    const gate = new RateGate(50);
    const t0 = Date.now();
    await gate.wait('C1');
    await gate.wait('C1');
    await gate.wait('C1');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(95); // 2 enforced gaps of ~50ms
  });

  it('does not couple different keys', async () => {
    const gate = new RateGate(200);
    const t0 = Date.now();
    await gate.wait('C1');
    await gate.wait('C2');
    expect(Date.now() - t0).toBeLessThan(150);
  });
});

describe('withBoundary', () => {
  it('contains handler exceptions so the socket never crashes', async () => {
    const wrapped = withBoundary('test', async () => {
      throw new Error('boom');
    });
    await expect(wrapped()).resolves.toBeUndefined();
  });
});
