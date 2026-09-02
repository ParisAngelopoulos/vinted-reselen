import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseOutputType, renameForType } from '../src/lib/image.js';

test('chooseOutputType keeps PNG, everything else becomes JPEG', () => {
  assert.deepEqual(chooseOutputType('image/png'), { type: 'image/png', extension: 'png' });
  assert.deepEqual(chooseOutputType('image/jpeg'), {
    type: 'image/jpeg',
    extension: 'jpg',
    quality: 0.92,
  });
  assert.equal(chooseOutputType('image/webp').type, 'image/jpeg');
  assert.equal(chooseOutputType(undefined).type, 'image/jpeg', 'a missing type must still encode');
});

test('renameForType swaps the extension rather than appending one', () => {
  assert.equal(renameForType('photo-1.webp', 'jpg'), 'photo-1.jpg');
  assert.equal(renameForType('photo-1', 'jpg'), 'photo-1.jpg');
  assert.equal(renameForType('a.b.png', 'jpg'), 'a.b.jpg');
});
