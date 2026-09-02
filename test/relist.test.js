import assert from 'node:assert/strict';
import test from 'node:test';

import { relistBatch, relistItem, summarise } from '../src/lib/relist.js';

/** Minimal stand-in for VintedApi that records the call order. */
function fakeApi(overrides = {}) {
  const calls = [];
  let nextId = 1000;
  const api = {
    calls,
    async getItem(id) {
      calls.push(['getItem', id]);
      return {
        item: {
          id,
          title: `Item ${id}`,
          description: 'beschrijving',
          price: { amount: '20.00', currency_code: 'EUR' },
          catalog_id: 221,
          brand_id: 53,
          brand: 'Nike',
          size_id: 207,
          status_id: 2,
          package_size_id: 2,
          color_ids: [1],
          photos: [
            { id: 1, full_size_url: 'https://images.vinted.net/1.jpg' },
            { id: 2, full_size_url: 'https://images.vinted.net/2.jpg' },
          ],
        },
      };
    },
    async downloadPhoto(url) {
      calls.push(['downloadPhoto', url]);
      return { size: 100 };
    },
    async uploadPhoto() {
      calls.push(['uploadPhoto']);
      nextId += 1;
      return { id: nextId, orientation: 0 };
    },
    async createItem(payload) {
      calls.push(['createItem', payload.item.title]);
      return { id: 9999 };
    },
    async deleteItem(id) {
      calls.push(['deleteItem', id]);
      return true;
    },
    ...overrides,
  };
  return api;
}

const fastSettings = {
  delayBetweenItemsSec: 0,
  jitterSec: 0,
  delayBetweenCallsMs: 0,
  keepBackups: false,
};

test('the upload filename follows the real file type, not the URL', async () => {
  // A WebP uploaded as "photo-1.jpg" gives the file a name that contradicts its
  // content type; Vinted image URLs do not always carry an extension.
  const filenames = [];
  const api = fakeApi({
    async downloadPhoto() {
      return { size: 100, type: 'image/webp' };
    },
    async uploadPhoto(_blob, { filename }) {
      filenames.push(filename);
      return { id: 1, orientation: 0 };
    },
  });
  await relistItem(api, 42, { settings: fastSettings });
  assert.deepEqual(filenames, ['photo-1.webp', 'photo-2.webp']);
});

test('relistItem copies photos, creates the new listing, then deletes the old one', async () => {
  const api = fakeApi();
  const result = await relistItem(api, 42, { settings: { ...fastSettings, order: 'create-first' } });

  assert.equal(result.status, 'relisted');
  assert.equal(result.newItemId, 9999);

  const names = api.calls.map((c) => c[0]);
  assert.deepEqual(names, [
    'getItem',
    'downloadPhoto',
    'uploadPhoto',
    'downloadPhoto',
    'uploadPhoto',
    'createItem',
    'deleteItem',
  ]);
  assert.ok(
    names.indexOf('createItem') < names.indexOf('deleteItem'),
    'the copy must exist before the original is removed',
  );
});

test('delete-first order removes the original before uploading the copy', async () => {
  const api = fakeApi();
  await relistItem(api, 42, { settings: { ...fastSettings, order: 'delete-first' } });
  const names = api.calls.map((c) => c[0]);
  assert.ok(names.indexOf('deleteItem') < names.indexOf('createItem'));
});

test('a failed delete after a successful create is reported, not retried blindly', async () => {
  const api = fakeApi({
    async deleteItem() {
      throw new Error('403');
    },
  });

  await assert.rejects(
    () => relistItem(api, 42, { settings: { ...fastSettings, order: 'create-first' } }),
    (error) => {
      assert.match(error.message, /staat online/);
      assert.equal(error.partial.newItemId, 9999);
      return true;
    },
  );
});

test('dry run creates and deletes nothing', async () => {
  const api = fakeApi();
  const result = await relistItem(api, 42, { settings: { ...fastSettings, dryRun: true } });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.payload.item.title, 'Item 42');

  const names = api.calls.map((c) => c[0]);
  assert.ok(!names.includes('createItem'), 'a dry run must never create a listing');
  assert.ok(!names.includes('deleteItem'), 'a dry run must never delete anything');
});

test('dry run really transfers the photos, so the risky step is actually tested', async () => {
  // Faking this step made the dry run report success and the real run fail on
  // exactly what was skipped — worse than having no dry run at all.
  const api = fakeApi();
  await relistItem(api, 42, { settings: { ...fastSettings, dryRun: true } });

  const names = api.calls.map((c) => c[0]);
  assert.equal(names.filter((n) => n === 'downloadPhoto').length, 2);
  assert.equal(names.filter((n) => n === 'uploadPhoto').length, 2);
});

test('a dry run fails when the photo upload is refused', async () => {
  const api = fakeApi({
    async uploadPhoto() {
      throw new Error('Accès refusé (POST /api/v2/photos)');
    },
  });
  await assert.rejects(
    () => relistItem(api, 42, { settings: { ...fastSettings, dryRun: true } }),
    /Accès refusé/,
  );
});

test('sold items are skipped without any write', async () => {
  const api = fakeApi({
    async getItem(id) {
      return { item: { id, title: 'Verkocht', price: '10.00', catalog_id: 1, is_closed: true, photos: [{ id: 1, url: 'x.jpg' }] } };
    },
  });
  const result = await relistItem(api, 7, { settings: fastSettings });
  assert.equal(result.status, 'skipped');
  assert.ok(result.reasons.includes('verkocht'));
  assert.deepEqual(api.calls, []);
});

test('a backup is taken before anything is deleted', async () => {
  const api = fakeApi();
  const saved = [];
  await relistItem(api, 42, {
    settings: { ...fastSettings, keepBackups: true, order: 'delete-first' },
    hooks: { saveBackup: async (entry) => { saved.push(entry); } },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].itemId, 42);
  assert.ok(saved[0].raw, 'the full item payload is kept so a failed relist can be recovered');
});

test('relistBatch keeps going after one item fails', async () => {
  let call = 0;
  const api = fakeApi({
    async createItem() {
      call += 1;
      if (call === 1) throw new Error('422 geweigerd');
      return { id: 1234 };
    },
  });

  const results = await relistBatch(api, [1, 2], { settings: fastSettings });
  assert.equal(results.length, 2);
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].error, /422/);
  assert.equal(results[1].status, 'relisted');
  assert.deepEqual(summarise(results), { relisted: 1, skipped: 0, failed: 1, 'dry-run': 0 });
});

test('relistBatch honours maxItemsPerRun', async () => {
  const api = fakeApi();
  const results = await relistBatch(api, [1, 2, 3, 4], {
    settings: { ...fastSettings, maxItemsPerRun: 2 },
  });
  assert.equal(results.length, 2);
});

test('an abort stops the batch immediately', async () => {
  const api = fakeApi();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => relistBatch(api, [1, 2], { settings: fastSettings, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
});
