/**
 * The API paths the Vinted site itself was seen calling, recorded by
 * src/content/api-recorder.js. Stored locally so they survive a page refresh
 * and can be read from the options page.
 *
 * Only method, path, query parameter names and status are ever kept — enough to
 * identify an endpoint, and nothing that could carry a token or personal data.
 */

const KEY = 'observedEndpoints';
const MAX = 300;

export async function listObserved() {
  const store = await chrome.storage.local.get(KEY);
  return store[KEY] || [];
}

/**
 * Recordings arrive in bursts — a page load fires several at once — and each
 * one is a read-modify-write on the same storage key. Without a queue the
 * second write is built on a snapshot taken before the first and silently
 * drops it, which is exactly the kind of loss that makes a recorder useless.
 */
let queue = Promise.resolve();

export function recordObserved({ entry, status }) {
  if (!entry) return Promise.resolve();

  const result = queue.then(async () => {
    const observed = await listObserved();
    const existing = observed.find((row) => row.entry === entry);
    if (existing) {
      existing.count += 1;
      existing.status = status ?? existing.status;
      existing.lastSeen = Date.now();
    } else {
      observed.push({ entry, status: status ?? 0, count: 1, lastSeen: Date.now() });
    }
    await chrome.storage.local.set({ [KEY]: observed.slice(-MAX) });
  });

  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function clearObserved() {
  await chrome.storage.local.remove(KEY);
}

/** Plain-text listing, ready to paste into a bug report. */
export function formatObserved(observed) {
  if (!observed.length) {
    return 'Nog niets waargenomen. Open Vinted, ga naar je kledingkast en ververs de pagina.';
  }
  return [...observed]
    .sort((a, b) => a.entry.localeCompare(b.entry))
    .map((row) => `${String(row.status).padStart(3)}  ${row.entry}`)
    .join('\n');
}
