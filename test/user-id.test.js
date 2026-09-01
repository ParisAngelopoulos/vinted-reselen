import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseMemberIdFromPath,
  parseWardrobeIdFromApiPath,
  resolveUserId,
  wardrobeIdsFromObserved,
} from '../src/lib/user-id.js';

test('parseMemberIdFromPath reads the id out of a profile URL', () => {
  assert.equal(parseMemberIdFromPath('/member/3152705349'), '3152705349');
  assert.equal(parseMemberIdFromPath('/member/3152705349-paris'), '3152705349');
  assert.equal(parseMemberIdFromPath('/member/3152705349/items'), '3152705349');
  assert.equal(parseMemberIdFromPath('/member/3152705349?tab=closet'), '3152705349');
});

test('parseMemberIdFromPath ignores anything that is not a profile', () => {
  assert.equal(parseMemberIdFromPath('/catalog'), null);
  assert.equal(parseMemberIdFromPath('/items/12345'), null);
  assert.equal(parseMemberIdFromPath('/members/123'), null, 'a similar path must not match');
  assert.equal(parseMemberIdFromPath('/member/abc'), null);
  assert.equal(parseMemberIdFromPath(''), null);
  assert.equal(parseMemberIdFromPath(undefined), null);
});

test('parseWardrobeIdFromApiPath reads the id out of a recorded call', () => {
  assert.equal(
    parseWardrobeIdFromApiPath('GET /api/v2/wardrobe/3152705349/items?order&page&per_page'),
    '3152705349',
  );
  assert.equal(parseWardrobeIdFromApiPath('GET /api/v2/banners'), null);
});

test('wardrobeIdsFromObserved ranks by how often each id was seen', () => {
  const observed = [
    { entry: 'GET /api/v2/wardrobe/111/items?page', count: 1 },
    { entry: 'GET /api/v2/wardrobe/999/items?page', count: 7 },
    { entry: 'GET /api/v2/banners', count: 3 },
  ];
  assert.deepEqual(wardrobeIdsFromObserved(observed), ['999', '111']);
  assert.deepEqual(wardrobeIdsFromObserved([]), []);
});

test('resolveUserId prefers a manual override over everything else', () => {
  const result = resolveUserId({
    override: ' 42 ',
    pathname: '/member/999',
    remembered: '888',
  });
  assert.equal(result.id, '42');
  assert.match(result.source, /handmatig/);
});

test('resolveUserId ignores an override that is not a number', () => {
  const result = resolveUserId({ override: 'mijn-account', pathname: '/member/999' });
  assert.equal(result.id, '999');
});

test('resolveUserId reads the open profile page before falling back', () => {
  const result = resolveUserId({ pathname: '/member/3152705349-paris', remembered: '111' });
  assert.equal(result.id, '3152705349');
  assert.match(result.source, /profielpagina/);
});

test('resolveUserId falls back to a remembered id, then to observed traffic', () => {
  assert.equal(resolveUserId({ remembered: '111', pathname: '/catalog' }).id, '111');
  assert.equal(
    resolveUserId({
      pathname: '/catalog',
      observed: [{ entry: 'GET /api/v2/wardrobe/222/items?page', count: 2 }],
    }).id,
    '222',
  );
});

test('resolveUserId reports failure rather than inventing an id', () => {
  const result = resolveUserId({ pathname: '/catalog' });
  assert.equal(result.id, null);
  assert.equal(result.source, 'onbekend');
});
