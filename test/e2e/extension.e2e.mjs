/**
 * End-to-end test: loads the unpacked extension into Chromium, points
 * "vinted.nl" at a local mock server, and drives a real relist through the
 * popup UI.
 *
 * Run with: npm run test:e2e
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createMockVinted } from './mock-vinted.mjs';

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8099;

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

async function withBrowser(run) {
  const mock = createMockVinted();
  await mock.listen(PORT);

  const userDataDir = mkdtempSync(join(tmpdir(), 'vinted-relister-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--host-resolver-rules=MAP www.vinted.nl 127.0.0.1:${PORT}, MAP *.vinted.nl 127.0.0.1:${PORT}`,
      '--ignore-certificate-errors',
      '--no-sandbox',
    ],
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionId = new URL(worker.url()).host;
    await run({ context, worker, extensionId, mock });
  } finally {
    await context.close();
    await mock.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

/** Wait until `probe` returns something truthy, or fail with `label`. */
async function until(probe, { label, timeout = 20_000, gap = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((r) => setTimeout(r, gap));
  }
  throw new Error(`Time-out: ${label}`);
}

// --------------------------------------------------------------- checks ----

check('de extensie laadt en de service worker start', async ({ extensionId }) => {
  assert.match(extensionId, /^[a-p]{32}$/, `onverwacht extension-id: ${extensionId}`);
});

check('het content script leest de eigen advertenties uit', async ({ context, extensionId }) => {
  const vinted = await context.newPage();
  await vinted.goto('http://www.vinted.nl/');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

  await popup.waitForSelector('.item', { timeout: 20_000 });
  const titles = await popup.$$eval('.item-title', (nodes) => nodes.map((n) => n.textContent));
  assert.deepEqual(titles, ['Nike hoodie', 'Levi 501', 'Verkochte trui']);

  const soldDisabled = await popup.$eval('.item:nth-child(3) input[type=checkbox]', (n) => n.disabled);
  assert.equal(soldDisabled, true, 'een verkocht item mag niet selecteerbaar zijn');
  await popup.close();
  await vinted.close();
});

check('zonder open Vinted-tabblad opent de extensie er zelf een', async ({ context, extensionId }) => {
  // Nothing is open on vinted.nl here: the worker has to create the tab itself,
  // on the domain the content script reported earlier.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForSelector('.item', { timeout: 30_000 });

  const opened = await popup.evaluate(() => chrome.storage.local.get('lastVintedOrigin'));
  assert.equal(opened.lastVintedOrigin, 'http://www.vinted.nl');
  await popup.close();
});

check('API-verzoeken dragen de headers die de Vinted-site zelf ook stuurt', async ({
  context,
  extensionId,
  mock,
}) => {
  const vinted = await context.newPage();
  await vinted.goto('http://www.vinted.nl/');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForSelector('.item');

  const apiCall = mock.calls.find((c) => c.path === '/api/v2/users/current');
  assert.ok(apiCall, 'de gebruiker hoort opgevraagd te zijn');
  assert.equal(
    apiCall.headers['x-anon-id'],
    'test-anon-id',
    'de anon_id-cookie hoort als X-Anon-Id teruggestuurd te worden',
  );
  assert.equal(
    apiCall.headers['x-csrf-token'],
    'test-csrf-token',
    'het CSRF-token van de pagina hoort meegestuurd te worden',
  );
  assert.equal(
    apiCall.headers['x-requested-with'],
    undefined,
    'een header die de echte site niet stuurt hoort er niet in te zitten',
  );

  await popup.close();
  await vinted.close();
});

check('de verbindingstest rapporteert per aanroep wat Vinted antwoordt', async ({
  context,
  extensionId,
}) => {
  const vinted = await context.newPage();
  await vinted.goto('http://www.vinted.nl/');

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.click('#run-diagnose');
  await page.waitForFunction(
    () => !document.getElementById('diagnose-output').textContent.startsWith('Bezig'),
    { timeout: 20_000 },
  );

  const output = await page.textContent('#diagnose-output');
  assert.match(output, /anon_id-cookie:\s+aanwezig/);
  assert.match(output, /Ingelogd als gebruiker 1\./);
  assert.match(output, /advertentie\(s\) gevonden/);
  assert.match(output, /✓ Ingelogde gebruiker: 200/);

  await page.close();
  await vinted.close();
});

check('een relist maakt de nieuwe advertentie aan en verwijdert de oude', async ({
  context,
  extensionId,
  mock,
}) => {
  const vinted = await context.newPage();
  await vinted.goto('http://www.vinted.nl/');

  const popup = await context.newPage();
  popup.on('dialog', (dialog) => dialog.accept());
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForSelector('.item');

  // No waiting between items — this is a test, not a live account.
  await popup.evaluate(() =>
    chrome.storage.local.set({
      settings: {
        order: 'create-first',
        delayBetweenItemsSec: 0,
        jitterSec: 0,
        delayBetweenCallsMs: 0,
        maxItemsPerRun: 10,
        priceMode: 'keep',
        minPrice: 1,
        dryRun: false,
        skipReserved: true,
        keepBackups: true,
      },
    }),
  );

  await popup.check('.item:nth-child(1) input[type=checkbox]');
  await popup.click('#start');

  await until(
    async () => {
      const state = await popup.evaluate(() => chrome.storage.local.get('runState'));
      return state.runState && state.runState.active === false && state.runState.done > 0
        ? state.runState
        : null;
    },
    { label: 'de sessie werd niet afgerond' },
  );

  assert.equal(mock.state.created.length, 1, 'er hoort één nieuwe advertentie te zijn aangemaakt');
  assert.deepEqual(mock.state.deleted, ['101'], 'de oude advertentie hoort verwijderd te zijn');

  const payload = mock.state.created[0];
  const created = payload.item;
  assert.equal(created.title, 'Nike hoodie');
  assert.equal(created.description, 'Nauwelijks gedragen, maat M.');
  assert.equal(created.price, '25.00');
  assert.equal(created.catalog_id, 221);
  assert.equal(created.brand_id, 53);
  assert.equal(created.size_id, 207);
  assert.equal(created.status_id, 2);
  assert.equal(created.id, null, 'de kopie mag het oude id niet dragen');
  assert.equal(created.assigned_photos.length, 2, 'beide foto’s horen opnieuw geüpload te zijn');
  assert.equal(payload.push_up, false, 'nooit ongevraagd een betaalde bump kopen');
  assert.ok(payload.upload_session_id, 'de upload-sessie hoort meegestuurd te worden');

  // Ordering: the copy must be created before the original is removed.
  const order = mock.calls
    .filter((c) => c.path === '/api/v2/item_upload/items' || c.path === '/api/v2/items/101')
    .map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(order, ['POST /api/v2/item_upload/items', 'DELETE /api/v2/items/101']);

  // Photos were downloaded from the original and re-uploaded.
  const photoUploads = mock.calls.filter((c) => c.path === '/api/v2/photos').length;
  assert.equal(photoUploads, 2);

  const backups = await popup.evaluate(() => chrome.storage.local.get('backups'));
  assert.equal(backups.backups.length, 1, 'er hoort een back-up bewaard te zijn vóór het verwijderen');
  assert.equal(backups.backups[0].itemId, 101);

  await popup.close();
  await vinted.close();
});

check('testmodus wijzigt niets', async ({ context, extensionId, mock }) => {
  const vinted = await context.newPage();
  await vinted.goto('http://www.vinted.nl/');

  const popup = await context.newPage();
  popup.on('dialog', (dialog) => dialog.accept());
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await popup.waitForSelector('.item');

  await popup.evaluate(() =>
    chrome.storage.local.set({
      settings: { dryRun: true, delayBetweenItemsSec: 0, jitterSec: 0, delayBetweenCallsMs: 0, maxItemsPerRun: 10 },
      runState: null,
    }),
  );
  await popup.reload();
  await popup.waitForSelector('.item');

  const createdBefore = mock.state.created.length;
  const deletedBefore = mock.state.deleted.length;

  await popup.check('.item:nth-child(1) input[type=checkbox]');
  await popup.click('#start');

  await until(
    async () => {
      const state = await popup.evaluate(() => chrome.storage.local.get('runState'));
      return state.runState && state.runState.active === false && state.runState.done > 0;
    },
    { label: 'de testmodus-sessie werd niet afgerond' },
  );

  assert.equal(mock.state.created.length, createdBefore, 'testmodus mag niets aanmaken');
  assert.equal(mock.state.deleted.length, deletedBefore, 'testmodus mag niets verwijderen');

  await popup.close();
  await vinted.close();
});

check('de recorder vangt op wat de site zelf aanroept, ook via XHR', async ({
  context,
  extensionId,
}) => {
  const vinted = await context.newPage();
  await vinted.goto('http://www.vinted.nl/');
  // A refresh re-injects the recorder rather than losing it — the whole point
  // of doing this from the extension instead of a pasted console snippet.
  await vinted.reload();
  await vinted.waitForTimeout(1000);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.click('#refresh-observed');
  await page.waitForFunction(
    () => document.getElementById('observed-output').textContent.includes('/api/'),
    { timeout: 10_000 },
  );

  const output = await page.textContent('#observed-output');
  assert.match(output, /GET \/api\/v2\/feed\?page&per_page/, 'fetch-verkeer hoort opgenomen te worden');
  assert.match(output, /POST \/api\/v2\/tracking/, 'XHR-verkeer hoort ook opgenomen te worden');
  assert.doesNotMatch(output, /test-csrf-token|anon_id=/, 'er mag geen token of cookie in belanden');
  assert.doesNotMatch(output, /per_page=20/, 'alleen parameternamen, geen waarden');

  await page.close();
  await vinted.close();
});

check('de instellingenpagina laadt en slaat op', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.waitForSelector('#form');

  // A field that depends on another control must actually disappear.
  assert.equal(
    await page.isVisible('#price-value-field'),
    false,
    'het prijsveld hoort verborgen te zijn zolang de prijs ongewijzigd blijft',
  );
  await page.selectOption('select[name=priceMode]', 'percent');
  assert.equal(await page.isVisible('#price-value-field'), true);

  await page.selectOption('select[name=order]', 'delete-first');
  await page.fill('input[name=delayBetweenItemsSec]', '90');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 0);

  const saved = await page.evaluate(() => chrome.storage.local.get('settings'));
  assert.equal(saved.settings.order, 'delete-first');
  assert.equal(saved.settings.delayBetweenItemsSec, 90);
  assert.deepEqual(errors, [], `fouten op de instellingenpagina: ${errors.join(', ')}`);

  await page.close();
});

// ----------------------------------------------------------------- run -----

const failures = [];
await withBrowser(async (ctx) => {
  for (const { name, fn } of checks) {
    try {
      await fn(ctx);
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failures.push({ name, error });
      console.error(`  ✗ ${name}\n    ${error.message}`);
    }
  }
});

console.log(`\n${checks.length - failures.length}/${checks.length} e2e-checks geslaagd.`);
process.exit(failures.length ? 1 : 0);
