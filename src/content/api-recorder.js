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
    for (const [entry, record] of entries) publish(entry, record);
  });

  function publish(entry, record) {
    window.postMessage(
      { source: CHANNEL, entry, status: record.status, headers: record.headers },
      location.origin,
    );
  }

  /**
   * Header *names* only — never values. A name says which headers the site
   * considers necessary, which is exactly what the extension needs to match;
   * a value could be a session token.
   */
  function headerNames(source) {
    try {
      if (!source) return [];
      const names = source instanceof Headers
        ? [...source.keys()]
        : Array.isArray(source)
          ? source.map(([name]) => name)
          : Object.keys(source);
      return [...new Set(names.map((name) => String(name).toLowerCase()))].sort();
    } catch {
      return [];
    }
  }

  function report(method, rawUrl, status, headers) {
    try {
      if (!rawUrl) return;
      const url = new URL(rawUrl, location.href);
      if (url.origin !== location.origin) return;
      if (!url.pathname.startsWith('/api/')) return;

      const keys = [...url.searchParams.keys()].sort();
      const query = keys.length ? `?${keys.join('&')}` : '';
      const entry = `${String(method || 'GET').toUpperCase()} ${url.pathname}${query}`;
      if (entries.has(entry)) return;
      const record = { status: status ?? 0, headers: headers ?? [] };
      entries.set(entry, record);

      if (listenerReady) publish(entry, record);
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
      const sent = headerNames(
        init?.headers ?? (typeof input === 'object' ? input?.headers : null),
      );
      const result = originalFetch.apply(this, arguments);
      // Observe the outcome without altering the promise the caller receives.
      Promise.resolve(result).then(
        (response) => report(method, url, response?.status, sent),
        () => report(method, url, 0, sent),
      );
      return result;
    };
  }

  // --- XMLHttpRequest ------------------------------------------------------
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const marker = Symbol('vinted-relister');

  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function open(method, url) {
    this[marker] = { method, url, headers: [] };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(name) {
    if (this[marker]) this[marker].headers.push(String(name).toLowerCase());
    return originalSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function send() {
    const info = this[marker];
    if (info) {
      this.addEventListener(
        'loadend',
        () => report(info.method, info.url, this.status, [...new Set(info.headers)].sort()),
        { once: true },
      );
    }
    return originalSend.apply(this, arguments);
  };
})();
