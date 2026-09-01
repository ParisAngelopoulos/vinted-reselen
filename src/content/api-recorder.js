/**
 * Records which API paths the Vinted site itself calls.
 *
 * Vinted has no public API, so the paths this extension uses were reconstructed
 * by hand and go stale when the site changes. Rather than guessing new ones,
 * this watches what the site's own JavaScript does and reports the paths.
 *
 * It must run in the page's own context (manifest `world: "MAIN"`), because an
 * isolated content script has its own `window.fetch` and would see nothing of
 * the page's traffic. Because Chrome re-injects it on every page load, a
 * refresh is what makes it work rather than what kills it.
 *
 * Recorded per call: the method, the path, the *names* of the query parameters,
 * and the status code. Never a request body, a response body, a header, a
 * cookie or a query parameter value — none of which are needed to identify an
 * endpoint, and all of which could carry personal data or a session token.
 */

(() => {
  const CHANNEL = 'vinted-relister-recorder';

  /**
   * This script runs at document_start so it can wrap fetch before the site's
   * own code does anything, while the content script that forwards to storage
   * only starts listening at document_idle. The site's first — and often most
   * interesting — calls happen in between, so everything is buffered here and
   * replayed once the listener announces itself.
   */
  const entries = new Map();
  let listenerReady = false;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== CHANNEL || !message.ready) return;
    listenerReady = true;
    for (const [entry, status] of entries) publish(entry, status);
  });

  function publish(entry, status) {
    window.postMessage({ source: CHANNEL, entry, status }, location.origin);
  }

  function report(method, rawUrl, status) {
    try {
      if (!rawUrl) return;
      const url = new URL(rawUrl, location.href);
      if (url.origin !== location.origin) return;
      if (!url.pathname.startsWith('/api/')) return;

      const keys = [...url.searchParams.keys()].sort();
      const query = keys.length ? `?${keys.join('&')}` : '';
      const entry = `${String(method || 'GET').toUpperCase()} ${url.pathname}${query}`;
      if (entries.has(entry)) return;
      entries.set(entry, status ?? 0);

      if (listenerReady) publish(entry, status ?? 0);
    } catch {
      /* never let bookkeeping break the page */
    }
  }

  // --- fetch ---------------------------------------------------------------
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function fetch(input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      const method = init?.method || (typeof input === 'object' ? input?.method : null) || 'GET';
      const result = originalFetch.apply(this, arguments);
      // Observe the outcome without altering the promise the caller receives.
      Promise.resolve(result).then(
        (response) => report(method, url, response?.status),
        () => report(method, url, 0),
      );
      return result;
    };
  }

  // --- XMLHttpRequest ------------------------------------------------------
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const marker = Symbol('vinted-relister');

  XMLHttpRequest.prototype.open = function open(method, url) {
    this[marker] = { method, url };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function send() {
    const info = this[marker];
    if (info) {
      this.addEventListener('loadend', () => report(info.method, info.url, this.status), { once: true });
    }
    return originalSend.apply(this, arguments);
  };
})();
