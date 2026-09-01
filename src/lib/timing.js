/**
 * Pacing helpers. Relisting hits the same endpoints the website itself uses,
 * so everything here exists to keep the request rate close to what a person
 * clicking through the UI would produce.
 */

export function sleep(ms, { signal } = {}) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Afgebroken', 'AbortError'));
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException('Afgebroken', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Base delay plus a random 0..jitter extra, both in seconds, returned as ms.
 * `random` is injectable so tests stay deterministic.
 */
export function jitteredDelayMs(baseSec, jitterSec, random = Math.random) {
  const base = Math.max(0, Number(baseSec) || 0);
  const jitter = Math.max(0, Number(jitterSec) || 0);
  return Math.round((base + random() * jitter) * 1000);
}

/**
 * Exponential backoff with a cap, used for 429/5xx retries.
 * attempt is 0-based: 0 -> baseMs, 1 -> 2x, 2 -> 4x ...
 */
export function backoffMs(attempt, { baseMs = 2000, maxMs = 60_000, random = Math.random } = {}) {
  const exponential = Math.min(baseMs * 2 ** attempt, maxMs);
  // Full jitter avoids a thundering herd when several items retry at once.
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

/**
 * Serialises calls and guarantees a minimum gap between them.
 * One instance per API client.
 */
export class Throttle {
  constructor(minGapMs = 0) {
    this.minGapMs = minGapMs;
    this.tail = Promise.resolve();
    this.lastRun = 0;
  }

  setGap(ms) {
    this.minGapMs = Math.max(0, Number(ms) || 0);
  }

  run(task, { signal } = {}) {
    const result = this.tail.then(async () => {
      const wait = this.lastRun + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait, { signal });
      this.lastRun = Date.now();
      return task();
    });
    // Keep the chain alive even when a task rejects.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
