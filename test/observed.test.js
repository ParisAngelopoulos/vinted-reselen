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

test('formatObserved lists the body field names of a write', () => {
  const output = formatObserved([
    {
      entry: 'POST /api/v2/photos',
      status: 200,
      count: 1,
      headers: ['accept', 'x-csrf-token'],
      fields: ['photo[type]', 'photo[temp_uuid]', 'photo[file] (bestand)'],
    },
  ]);
  assert.match(output, /velden:\s+photo\[type\], photo\[temp_uuid\], photo\[file\] \(bestand\)/);
});

test('formatObserved lists the header names the site sent', () => {
  const output = formatObserved([
    { entry: 'GET /api/v2/wardrobe/1/items?page', status: 200, count: 1, headers: ['accept', 'x-anon-id'] },
  ]);
  assert.match(output, /headers: accept, x-anon-id/);
});

test('formatObserved explains what to do when nothing was recorded yet', () => {
  assert.match(formatObserved([]), /profiel/);
});
