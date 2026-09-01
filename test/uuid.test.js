import assert from 'node:assert/strict';
import test from 'node:test';

import { uuid } from '../src/lib/uuid.js';

test('uuid produces a valid v4 identifier', () => {
  const value = uuid();
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('uuid works without crypto.randomUUID, which only exists in a secure context', () => {
  const original = globalThis.crypto;
  try {
    // Same shape as an http page: getRandomValues present, randomUUID absent.
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: original.getRandomValues.bind(original) },
      configurable: true,
    });
    assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
  }
});

test('uuid values do not repeat', () => {
  const values = new Set(Array.from({ length: 500 }, () => uuid()));
  assert.equal(values.size, 500);
});
