import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockingReasons,
  buildCreatePayload,
  computeNewPrice,
  extractAmount,
  normalizeItem,
} from '../src/lib/item-mapper.js';

test('extractAmount handles the shapes Vinted returns', () => {
  assert.equal(extractAmount(12.5), '12.50');
  assert.equal(extractAmount('12.50'), '12.50');
  assert.equal(extractAmount('12,50'), '12.50');
  assert.equal(extractAmount({ amount: '9.99', currency_code: 'EUR' }), '9.99');
  assert.equal(extractAmount(null), null);
  assert.equal(extractAmount('nonsense'), null);
});

test('normalizeItem reads the upload-form shape', () => {
  const item = normalizeItem({
    item: {
      id: 42,
      title: 'Nike hoodie',
      description: 'Nauwelijks gedragen',
      price: { amount: '25.00', currency_code: 'EUR' },
      catalog_id: 221,
      brand_id: 53,
      brand: 'Nike',
      size_id: 207,
      status_id: 2,
      package_size_id: 2,
      color_ids: [1, 5],
      photos: [{ id: 9, full_size_url: 'https://images.vinted.net/a.jpg' }],
      item_attributes: [{ code: 'material', ids: [12] }],
    },
  });

  assert.equal(item.id, 42);
  assert.equal(item.price, '25.00');
  assert.equal(item.currency, 'EUR');
  assert.equal(item.brandId, 53);
  assert.equal(item.brandTitle, 'Nike');
  assert.deepEqual(item.colorIds, [1, 5]);
  assert.equal(item.photos.length, 1);
  assert.equal(item.photos[0].url, 'https://images.vinted.net/a.jpg');
  assert.deepEqual(item.attributes, [{ code: 'material', ids: [12] }]);
});

test('normalizeItem reads the public item shape', () => {
  const item = normalizeItem({
    id: 7,
    title: 'Jeans',
    price: '30.00',
    brand_dto: { id: 88, title: 'Levi’s' },
    color1_id: 3,
    color2_id: 0,
    catalog_id: 257,
    photos: [{ id: 1, url: 'https://images.vinted.net/small.jpg', high_resolution: { full_size_url: 'https://images.vinted.net/big.jpg' } }],
    is_closed: true,
  });

  assert.equal(item.brandId, 88);
  assert.equal(item.brandTitle, 'Levi’s');
  assert.deepEqual(item.colorIds, [3], 'colour id 0 is a placeholder and must be dropped');
  assert.equal(item.photos[0].url, 'https://images.vinted.net/big.jpg');
  assert.equal(item.photos[0].source, 'high_resolution.full_size_url');
  assert.deepEqual(
    item.photos[0].available,
    ['high_resolution.full_size_url', 'url'],
    'knowing which variants exist tells us whether a thumbnail was uploaded',
  );
  assert.equal(item.isSold, true);
});

test('computeNewPrice applies the configured rule and floor', () => {
  assert.equal(computeNewPrice('20.00', { priceMode: 'keep' }), '20.00');
  assert.equal(computeNewPrice('20.00', { priceMode: 'percent', priceValue: -10 }), '18.00');
  assert.equal(computeNewPrice('20.00', { priceMode: 'absolute', priceValue: 2.5 }), '22.50');
  assert.equal(
    computeNewPrice('2.00', { priceMode: 'percent', priceValue: -90, minPrice: 1 }),
    '1.00',
    'never drops below the configured floor',
  );
  assert.equal(computeNewPrice(null, {}), null);
});

test('blockingReasons refuses items that must not be touched', () => {
  const base = { isSold: false, isReserved: false, isDraft: false, photos: [{}], catalogId: 1, price: '5.00' };
  assert.deepEqual(blockingReasons(base, {}), []);
  assert.ok(blockingReasons({ ...base, isSold: true }, {}).includes('verkocht'));
  assert.ok(blockingReasons({ ...base, isReserved: true }, { skipReserved: true }).includes('gereserveerd'));
  assert.deepEqual(blockingReasons({ ...base, isReserved: true }, { skipReserved: false }), []);
  assert.ok(blockingReasons({ ...base, photos: [] }, {}).length > 0);
});

test('blockingReasons honours the minimum age filter', () => {
  const base = { isSold: false, isReserved: false, isDraft: false, photos: [{}], catalogId: 1, price: '5.00' };
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
  assert.ok(blockingReasons({ ...base, createdAtTs: twoDaysAgo }, { minAgeDays: 7 }).length > 0);
  assert.deepEqual(blockingReasons({ ...base, createdAtTs: twoDaysAgo }, { minAgeDays: 1 }), []);
});

test('buildCreatePayload keeps every copied field and no identity', () => {
  const item = normalizeItem({
    item: {
      id: 42,
      title: 'Nike hoodie',
      description: 'Beschrijving',
      price: { amount: '25.00', currency_code: 'EUR' },
      catalog_id: 221,
      brand_id: 53,
      brand: 'Nike',
      size_id: 207,
      status_id: 2,
      package_size_id: 2,
      color_ids: [1],
      photos: [{ id: 9, full_size_url: 'https://images.vinted.net/a.jpg' }],
    },
  });

  const payload = buildCreatePayload(item, {
    photoIds: [{ id: 111, orientation: 0 }],
    uploadSessionId: 'session-uuid',
    tempUuid: 'temp-uuid',
    price: '25.00',
  });

  assert.equal(payload.item.id, null, 'the copy must not carry the old id');
  assert.equal(payload.item.title, 'Nike hoodie');
  assert.equal(payload.item.catalog_id, 221);
  assert.equal(payload.item.brand_id, 53);
  assert.equal(payload.item.price, '25.00');
  assert.equal(payload.upload_session_id, 'session-uuid');
  assert.equal(payload.item.temp_uuid, 'temp-uuid');
  assert.deepEqual(payload.item.assigned_photos, [{ id: 111, orientation: 0, position: 0 }]);
  assert.equal(payload.push_up, false, 'never spend the user’s money on a bump');
});

test('buildCreatePayload refuses to create a listing without photos', () => {
  const item = normalizeItem({ item: { id: 1, title: 'x', photos: [] } });
  assert.throws(() => buildCreatePayload(item, { photoIds: [], uploadSessionId: 'a', tempUuid: 'b' }), /foto/i);
});
