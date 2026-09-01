import assert from 'node:assert/strict';
import test from 'node:test';

import { Throttle, backoffMs, jitteredDelayMs, sleep } from '../src/lib/timing.js';

test('jitteredDelayMs stays within base..base+jitter', () => {
  assert.equal(jitteredDelayMs(45, 20, () => 0), 45_000);
  assert.equal(jitteredDelayMs(45, 20, () => 1), 65_000);
  assert.equal(jitteredDelayMs(0, 0), 0);
  assert.equal(jitteredDelayMs(-5, -5), 0, 'negative settings never produce a negative wait');
});

test('backoffMs grows exponentially and is capped', () => {
  assert.equal(backoffMs(0, { baseMs: 2000, random: () => 0 }), 1000);
  assert.equal(backoffMs(1, { baseMs: 2000, random: () => 0 }), 2000);
  assert.equal(backoffMs(2, { baseMs: 2000, random: () => 0 }), 4000);
  assert.equal(backoffMs(20, { baseMs: 2000, maxMs: 60_000, random: () => 1 }), 60_000);
});

test('Throttle keeps a minimum gap between calls', async () => {
  const throttle = new Throttle(40);
  const stamps = [];
  await Promise.all([1, 2, 3].map(() => throttle.run(async () => stamps.push(Date.now()))));
  assert.equal(stamps.length, 3);
  assert.ok(stamps[1] - stamps[0] >= 35, `gap was ${stamps[1] - stamps[0]}ms`);
  assert.ok(stamps[2] - stamps[1] >= 35, `gap was ${stamps[2] - stamps[1]}ms`);
});

test('Throttle survives a rejecting task', async () => {
  const throttle = new Throttle(0);
  await assert.rejects(() => throttle.run(async () => { throw new Error('boom'); }));
  const value = await throttle.run(async () => 'still working');
  assert.equal(value, 'still working');
});

test('sleep rejects when the signal aborts', async () => {
  const controller = new AbortController();
  const pending = sleep(5000, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error) => error.name === 'AbortError');
});
