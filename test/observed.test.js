import assert from 'node:assert/strict';
import test from 'node:test';

import { formatObserved } from '../src/lib/observed.js';

test('formatObserved sorts and lines up the status codes', () => {
  const output = formatObserved([
    { entry: 'POST /api/v2/photos', status: 200, count: 3 },
    { entry: 'GET /api/v2/feed?page', status: 403, count: 1 },
  ]);
  assert.equal(output, '403  GET /api/v2/feed?page\n200  POST /api/v2/photos');
});

test('formatObserved explains what to do when nothing was recorded yet', () => {
  assert.match(formatObserved([]), /profiel/);
});
