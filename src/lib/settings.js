/**
 * Default settings and storage helpers.
 *
 * Settings live in chrome.storage.local so the popup, the options page and the
 * service worker all read the same values.
 */

export const DEFAULT_SETTINGS = {
  /**
   * "create-first": upload the copy, then delete the original. Safest — if the
   * upload fails the original listing is still online.
   * "delete-first": delete the original, then upload the copy. Matches what a
   * manual relist looks like, but a failure leaves the item offline (the item
   * data is kept in the local backup so it can be retried).
   */
  order: 'create-first',

  /** Seconds to wait between two items in a batch. Keeps traffic human-paced. */
  delayBetweenItemsSec: 45,

  /** Extra random jitter (0..N seconds) added on top of the delay. */
  jitterSec: 20,

  /** Milliseconds between individual API calls inside one item. */
  delayBetweenCallsMs: 900,

  /** Max items handled in a single run. */
  maxItemsPerRun: 10,

  /**
   * Price change applied to the copy.
   * mode: 'keep' | 'percent' | 'absolute'
   */
  priceMode: 'keep',
  priceValue: 0,

  /** Never let an automatic price change drop below this. */
  minPrice: 1,

  /** Simulate everything (fetch + build payload) without creating or deleting. */
  dryRun: false,

  /** Skip items that already have a reservation/booking or are sold. */
  skipReserved: true,

  /** Only relist items older than this many days. 0 = no age filter. */
  minAgeDays: 0,

  /** Scheduled auto-relist. */
  scheduleEnabled: false,
  scheduleIntervalHours: 24,
  scheduleItemsPerRun: 3,

  /** Keep a local copy of the item data before deleting, for recovery. */
  keepBackups: true,
  backupRetentionDays: 30,
};

const SETTINGS_KEY = 'settings';

export async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

export async function saveSettings(partial) {
  const current = await loadSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
  return { ...DEFAULT_SETTINGS };
}
