/**
 * Local, on-device backups of item data taken right before a listing is
 * deleted. Nothing leaves the browser; this exists so a failed relist can be
 * inspected or retried instead of losing the item's details.
 */

const KEY = 'backups';

export async function saveBackup(entry) {
  const store = await chrome.storage.local.get(KEY);
  const backups = store[KEY] || [];
  backups.unshift({ ...entry, savedAt: Date.now() });
  await chrome.storage.local.set({ [KEY]: backups.slice(0, 200) });
}

export async function listBackups() {
  const store = await chrome.storage.local.get(KEY);
  return store[KEY] || [];
}

export async function pruneBackups(retentionDays = 30) {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const backups = await listBackups();
  const kept = backups.filter((entry) => (entry.savedAt || 0) >= cutoff);
  if (kept.length !== backups.length) {
    await chrome.storage.local.set({ [KEY]: kept });
  }
  return backups.length - kept.length;
}

export async function clearBackups() {
  await chrome.storage.local.remove(KEY);
}
