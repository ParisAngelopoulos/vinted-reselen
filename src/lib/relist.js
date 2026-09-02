/**
 * The relist engine: take one existing listing and put an identical one back
 * online, then remove the original.
 *
 * Kept free of chrome.* APIs so it can be driven by tests with a fake API
 * client. Side effects that need storage are injected via `hooks`.
 */

import {
  blockingReasons,
  buildCreatePayload,
  computeNewPrice,
  describeItem,
  normalizeItem,
} from './item-mapper.js';
import { jitteredDelayMs, sleep } from './timing.js';
import { uuid } from './uuid.js';

export const STEP = {
  FETCH: 'fetch',
  CHECK: 'check',
  PHOTOS: 'photos',
  CREATE: 'create',
  DELETE: 'delete',
  DONE: 'done',
};

const EXTENSION_FOR_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/**
 * Exported so the connection test can name its probe upload the same way.
 *
 * Name the upload after what the file actually is. Vinted's image URLs do not
 * always carry an extension, and guessing ".jpg" for a WebP gives the upload a
 * filename that contradicts its content type.
 */
export function filenameFor(index, url, blob) {
  const fromType = EXTENSION_FOR_TYPE[String(blob?.type || '').toLowerCase()];
  const fromUrl = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.exec(url || '')?.[1]?.toLowerCase();
  const ext = fromType || (fromUrl === 'jpeg' ? 'jpg' : fromUrl) || 'jpg';
  return `photo-${index + 1}.${ext}`;
}

/**
 * Relist a single item.
 *
 * @param {import('./api.js').VintedApi} api
 * @param {number|string} itemId
 * @param {object} options
 * @param {object} options.settings
 * @param {(update: {step: string, message: string, itemId: any, progress?: number}) => void} [options.onProgress]
 * @param {{saveBackup?: (entry:any)=>Promise<void>}} [options.hooks]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{status: 'relisted'|'skipped'|'dry-run', itemId: any, newItemId?: any, reasons?: string[], title: string}>}
 */
export async function relistItem(api, itemId, options = {}) {
  const { settings = {}, onProgress = () => {}, hooks = {}, signal } = options;
  const report = (step, message, extra = {}) => onProgress({ step, message, itemId, ...extra });

  report(STEP.FETCH, 'Gegevens ophalen…');
  const raw = await api.getItem(itemId, { signal });
  if (!raw) {
    throw new Error(`Item ${itemId} niet gevonden.`);
  }
  const item = normalizeItem(raw);
  const label = describeItem(item);

  report(STEP.CHECK, 'Controleren…');
  const reasons = blockingReasons(item, settings);
  if (reasons.length) {
    report(STEP.DONE, `Overgeslagen: ${reasons.join(', ')}`);
    return { status: 'skipped', itemId, reasons, title: item.title || String(itemId) };
  }

  const price = computeNewPrice(item.price, settings);
  const uploadSessionId = uuid();
  const tempUuid = uuid();

  // --- photos -------------------------------------------------------------
  //
  // The photos are transferred in a dry run too. They go to a temporary upload
  // session, which creates no listing and deletes nothing, so it is safe — and
  // it is by far the most failure-prone step. A test mode that fakes this step
  // reports success and then the real run fails on the very thing it skipped,
  // which is worse than having no test mode at all.
  const uploaded = [];
  for (const [index, photo] of item.photos.entries()) {
    signal?.throwIfAborted();
    report(STEP.PHOTOS, `Foto ${index + 1}/${item.photos.length} overzetten…`, {
      progress: index / item.photos.length,
    });
    const blob = await api.downloadPhoto(photo.url, { signal });
    const result = await api.uploadPhoto(blob, {
      tempUuid,
      filename: filenameFor(index, photo.url, blob),
      signal,
    });
    uploaded.push({ id: result.id, orientation: photo.orientation ?? 0 });
  }

  const payload = buildCreatePayload(item, { photoIds: uploaded, uploadSessionId, tempUuid, price });

  if (settings.dryRun) {
    report(
      STEP.DONE,
      `Testmodus geslaagd: ${label} — ${item.photos.length} foto’s overgezet, ` +
        `zou opnieuw geplaatst worden voor ${price} ${item.currency}. ` +
        'Er is niets aangemaakt en niets verwijderd.',
    );
    return { status: 'dry-run', itemId, title: item.title, payload };
  }

  // Keep the original's data locally before anything destructive happens.
  if (settings.keepBackups !== false && hooks.saveBackup) {
    await hooks.saveBackup({
      itemId,
      title: item.title,
      price: item.price,
      currency: item.currency,
      raw,
    });
  }

  // --- create / delete ----------------------------------------------------
  let newItemId = null;
  if (settings.order === 'delete-first') {
    signal?.throwIfAborted();
    report(STEP.DELETE, 'Oude advertentie verwijderen…');
    await api.deleteItem(itemId, { signal });
    await sleep(settings.delayBetweenCallsMs ?? 900, { signal });

    report(STEP.CREATE, 'Nieuwe advertentie plaatsen…');
    const created = await api.createItem(payload, { signal });
    newItemId = created.id;
  } else {
    signal?.throwIfAborted();
    report(STEP.CREATE, 'Nieuwe advertentie plaatsen…');
    const created = await api.createItem(payload, { signal });
    newItemId = created.id;
    await sleep(settings.delayBetweenCallsMs ?? 900, { signal });

    report(STEP.DELETE, 'Oude advertentie verwijderen…');
    try {
      await api.deleteItem(itemId, { signal });
    } catch (error) {
      // The copy is live — surface this clearly instead of failing the whole
      // item, otherwise a retry would create a second duplicate.
      const message = `Nieuwe advertentie ${newItemId} staat online, maar het verwijderen van ${itemId} mislukte: ${error.message}`;
      report(STEP.DONE, message);
      const wrapped = new Error(message);
      wrapped.partial = { newItemId, itemId };
      throw wrapped;
    }
  }

  report(STEP.DONE, `Klaar: ${label} → nieuwe advertentie ${newItemId}.`);
  return { status: 'relisted', itemId, newItemId, title: item.title };
}

/**
 * Relist a list of items one by one, pausing between them.
 *
 * Never aborts the whole run because of one bad item: failures are collected
 * and reported so the rest of the batch still goes through.
 */
export async function relistBatch(api, itemIds, options = {}) {
  const { settings = {}, onProgress = () => {}, onItemDone = () => {}, hooks = {}, signal } = options;
  const results = [];
  const limit = Math.max(1, Number(settings.maxItemsPerRun) || itemIds.length);
  const queue = itemIds.slice(0, limit);

  for (const [index, itemId] of queue.entries()) {
    signal?.throwIfAborted();

    if (index > 0) {
      const waitMs = jitteredDelayMs(settings.delayBetweenItemsSec, settings.jitterSec);
      onProgress({
        step: 'wait',
        itemId,
        message: `Wachten ${Math.round(waitMs / 1000)}s voor het volgende item…`,
      });
      await sleep(waitMs, { signal });
    }

    onProgress({
      step: 'start',
      itemId,
      message: `Item ${index + 1}/${queue.length}`,
      index,
      total: queue.length,
    });

    try {
      const result = await relistItem(api, itemId, { settings, onProgress, hooks, signal });
      results.push(result);
      onItemDone(result);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const failure = {
        status: 'failed',
        itemId,
        error: error.message,
        partial: error.partial ?? null,
      };
      results.push(failure);
      onItemDone(failure);
      onProgress({ step: 'error', itemId, message: `Mislukt: ${error.message}` });
    }
  }

  return results;
}

/** Summary counts for the UI. */
export function summarise(results) {
  const counts = { relisted: 0, skipped: 0, failed: 0, 'dry-run': 0 };
  for (const result of results) {
    if (counts[result.status] !== undefined) counts[result.status] += 1;
  }
  return counts;
}
