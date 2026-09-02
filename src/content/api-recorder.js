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
  let lastToken = null;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== CHANNEL || !message.ready) return;
    listenerReady = true;
    for (const [entry, record] of entries) publish(entry, record);
    // The token is usually seen on the site's very first call, long before the
    // listener exists, so it has to be replayed here as well.
    if (lastToken) publishCsrf(lastToken);
  });

  function publish(entry, record) {
    window.postMessage(
      {
        source: CHANNEL,
        entry,
        status: record.status,
        headers: record.headers,
        fields: record.fields,
      },
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

  /**
   * The site sends x-csrf-token on every API call, and writes are refused
   * without it. It is not in a cookie or a meta tag, so rather than guessing
   * where the front-end keeps it, read the value off the site's own requests.
   *
   * This is the one header value that gets captured — everything else is
   * recorded by name only. It never leaves the browser: it goes to the
   * extension's in-memory session storage and is used only to make the same
   * requests the signed-in user could make by hand.
   */
  function publishCsrf(token) {
    window.postMessage({ source: CHANNEL, csrfToken: token }, location.origin);
  }

  function captureCsrf(name, value) {
    if (String(name).toLowerCase() !== 'x-csrf-token') return;
    if (!value || value === lastToken) return;
    lastToken = value;
    if (listenerReady) publishCsrf(lastToken);
  }

  function captureCsrfFrom(source) {
    try {
      if (!source) return;
      if (source instanceof Headers) {
        for (const [name, value] of source.entries()) captureCsrf(name, value);
      } else if (Array.isArray(source)) {
        for (const [name, value] of source) captureCsrf(name, value);
      } else {
        for (const [name, value] of Object.entries(source)) captureCsrf(name, value);
      }
    } catch {
      /* never let this break the page */
    }
  }

  /**
   * Field *names* of a request body, never file contents.
   *
   * Values are recorded for one endpoint only: the photo upload. Its non-file
   * fields are structural constants (a type enum, a client-generated uuid) and
   * they are the last unknown in a request the extension has to reproduce
   * exactly. Everywhere else only names are kept, since a body there can carry
   * a description, a price, or anything else personal.
   */
  const VALUES_ALLOWED_ON = /\/api\/v\d+\/photos$/;
  function bodyFields(body, { withValues = false } = {}) {
    try {
      if (!body) return [];
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const names = [];
        for (const [name, value] of body.entries()) {
          const isFile = typeof value === 'object' && value !== null && 'size' in value;
          if (isFile) {
            names.push(`${name} (bestand)`);
          } else if (withValues && String(value).length <= 64) {
            names.push(`${name}=${value}`);
          } else {
            names.push(name);
          }
        }
        return [...new Set(names)];
      }
      if (typeof body === 'string' && body.trim().startsWith('{')) {
        const parsed = JSON.parse(body);
        return Object.keys(parsed).sort();
      }
      return [];
    } catch {
      return [];
    }
  }

  function report(method, rawUrl, status, headers, fields) {
    try {
      if (!rawUrl) return;
      const url = new URL(rawUrl, location.href);
      if (url.origin !== location.origin) return;
      if (!url.pathname.startsWith('/api/')) return;

      const keys = [...url.searchParams.keys()].sort();
      const query = keys.length ? `?${keys.join('&')}` : '';
      const entry = `${String(method || 'GET').toUpperCase()} ${url.pathname}${query}`;
      if (entries.has(entry)) return;
      const record = { status: status ?? 0, headers: headers ?? [], fields: fields ?? [] };
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
      const rawHeaders = init?.headers ?? (typeof input === 'object' ? input?.headers : null);
      const sent = headerNames(rawHeaders);
      let withValues = false;
      try {
        withValues = VALUES_ALLOWED_ON.test(new URL(url, location.href).pathname);
      } catch {
        /* leave it off when the URL cannot be parsed */
      }
      const fields = bodyFields(init?.body, { withValues });
      captureCsrfFrom(rawHeaders);
      const result = originalFetch.apply(this, arguments);
      // Observe the outcome without altering the promise the caller receives.
      Promise.resolve(result).then(
        (response) => report(method, url, response?.status, sent, fields),
        () => report(method, url, 0, sent, fields),
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

  XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader(name, value) {
    if (this[marker]) this[marker].headers.push(String(name).toLowerCase());
    captureCsrf(name, value);
    return originalSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function send(body) {
    const info = this[marker];
    if (info) {
      const fields = bodyFields(body);
      this.addEventListener(
        'loadend',
        () => report(info.method, info.url, this.status, [...new Set(info.headers)].sort(), fields),
        { once: true },
      );
    }
    return originalSend.apply(this, arguments);
  };
})();
