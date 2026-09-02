/**
 * Thin wrapper around the internal Vinted web API.
 *
 * This runs inside a content script on a vinted.* page, so requests are
 * same-origin and the browser attaches the normal session cookies. Nothing
 * here stores or forwards credentials anywhere.
 *
 * The endpoints below are the ones the Vinted web app itself calls. They are
 * not a public, versioned API and can change; every call therefore reports a
 * precise error instead of failing silently, and the read paths try a couple
 * of known variants.
 */

import { Throttle, backoffMs, sleep } from './timing.js';

export class VintedApiError extends Error {
  constructor(message, { status = 0, path = '', method = 'GET', body = null } = {}) {
    // Name the call in the message itself: this is the only thing the user
    // sees in the popup, and "which request failed" is the first question.
    super(path ? `${message} (${method} ${path})` : message);
    this.name = 'VintedApiError';
    this.status = status;
    this.path = path;
    this.method = method;
    this.body = body;
  }

  get isAuth() {
    return this.status === 401 || this.status === 403;
  }

  get isRateLimit() {
    return this.status === 429;
  }

  /**
   * An API that answers with an HTML page instead of JSON is not answering as
   * an API at all: that is a protection or challenge page. Saying "log in
   * again" there sends the user off to fix something that is not broken.
   */
  get isBlockPage() {
    return Boolean(this.body && typeof this.body === 'object' && this.body.__html);
  }
}

/** Recognise a response body that is a web page rather than an API answer. */
function asHtmlMarker(text) {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  if (!head.startsWith('<!doctype html') && !head.startsWith('<html')) return null;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() || null;
  return { __html: true, title, snippet: text.replace(/\s+/g, ' ').slice(0, 120) };
}

/** Sent on every request, exactly as the site's own front-end does. */
const ACCEPT_JSON = 'application/json, text/plain, */*';

/** Added on top of that for requests that carry a JSON body. */
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export class VintedApi {
  /**
   * @param {object} opts
   * @param {string} opts.origin      e.g. "https://www.vinted.nl"
   * @param {string} [opts.csrfToken] value of the page's CSRF meta tag
   * @param {number} [opts.minGapMs]  minimum gap between requests
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({
    origin,
    csrfToken = null,
    anonId = null,
    locale = null,
    minGapMs = 900,
    fetchImpl = globalThis.fetch.bind(globalThis),
  } = {}) {
    this.origin = (origin || globalThis.location?.origin || '').replace(/\/$/, '');
    this.csrfToken = csrfToken;
    this.anonId = anonId;
    this.locale = locale;
    this.fetchImpl = fetchImpl;
    this.throttle = new Throttle(minGapMs);
    this.maxRetries = 3;
  }

  /**
   * Find the CSRF token. Writes are refused without it while reads work fine,
   * so a missing token looks like "Access denied" on upload only.
   *
   * Checked in order: the classic Rails meta tag, the Next.js bootstrap, and
   * finally a cookie whose name mentions csrf — which is where a front-end that
   * renders no meta tag usually keeps it.
   */
  static readCsrfToken(doc = globalThis.document) {
    const meta = doc?.querySelector('meta[name="csrf-token"]');
    if (meta?.content) return meta.content;
    // Newer builds ship it inside the Next.js bootstrap payload.
    const next = doc?.getElementById('__NEXT_DATA__');
    if (next?.textContent) {
      try {
        const data = JSON.parse(next.textContent);
        const token = data?.props?.pageProps?.csrfToken || data?.props?.csrfToken;
        if (token) return token;
      } catch {
        /* not fatal — the header is optional for GETs */
      }
    }
    return VintedApi.readCsrfCookie(doc?.cookie);
  }

  /** A cookie whose name mentions csrf, if the page carries one. */
  static readCsrfCookie(cookieString) {
    const match = /(?:^|;\s*)([^=;\s]*csrf[^=;\s]*)=([^;]*)/i.exec(cookieString || '');
    if (!match) return null;
    try {
      return decodeURIComponent(match[2]) || null;
    } catch {
      return match[2] || null;
    }
  }

  /** The language the site itself is running in; it sends this as `locale`. */
  static readLocale(doc = globalThis.document) {
    const lang = doc?.documentElement?.lang;
    if (lang) return lang.split('-')[0].toLowerCase();
    const cookie = /(?:^|;\s*)(?:user|anonymous)-iso-locale=([^;]+)/i.exec(doc?.cookie || '');
    return cookie ? decodeURIComponent(cookie[1]).split('-')[0].toLowerCase() : null;
  }

  /** Cookie names present, never values — for the connection report. */
  static cookieNames(cookieString = globalThis.document?.cookie) {
    return (cookieString || '')
      .split(';')
      .map((part) => part.split('=')[0].trim())
      .filter(Boolean)
      .sort();
  }

  /**
   * The `anon_id` cookie. Vinted's own front-end echoes it back as an
   * `X-Anon-Id` header on every API call, and several routes answer 403 when
   * it is missing — even with a perfectly valid session cookie.
   */
  static readAnonId(cookieString = globalThis.document?.cookie) {
    const match = /(?:^|;\s*)anon_id=([^;]*)/.exec(cookieString || '');
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]) || null;
    } catch {
      return match[1] || null;
    }
  }

  static fromPage(overrides = {}) {
    return new VintedApi({
      origin: globalThis.location?.origin,
      csrfToken: VintedApi.readCsrfToken(),
      anonId: VintedApi.readAnonId(),
      locale: VintedApi.readLocale(),
      ...overrides,
    });
  }

  setGap(ms) {
    this.throttle.setGap(ms);
  }

  /**
   * Match the header set Vinted's own web app sends — no more and no less.
   * An extra header the real client never sends (X-Requested-With, say) makes
   * the request stand out to the bot-protection layer, which is a good way to
   * earn a 403 while holding a perfectly valid session.
   */
  headers(extra = {}) {
    // Vinted runs on Rails, which negotiates on Accept: a request that does not
    // ask for JSON is answered with the HTML page instead of API data. Without
    // this the reply is a web page, which reads as "blocked" but is really just
    // the wrong representation being served.
    const headers = { Accept: ACCEPT_JSON, ...extra };
    if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
    if (this.anonId) headers['X-Anon-Id'] = this.anonId;
    if (this.locale) headers.Locale = this.locale;
    return headers;
  }

  /**
   * Perform one API call, retrying on 429 and 5xx.
   * @returns {Promise<any>} parsed JSON, or null for empty bodies
   */
  async request(path, { method = 'GET', body, headers, raw = false, signal } = {}) {
    const url = path.startsWith('http') ? path : `${this.origin}${path}`;
    let lastError = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs(attempt - 1), { signal });

      const response = await this.throttle.run(
        () =>
          this.fetchImpl(url, {
            method,
            credentials: 'include',
            headers: this.headers(headers),
            body,
            signal,
          }),
        { signal },
      );

      if (response.ok) {
        if (raw) return response;
        if (response.status === 204) return null;
        const text = await response.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new VintedApiError('Onverwacht antwoord van Vinted (geen JSON).', {
            status: response.status,
            path,
            method,
            body: text.slice(0, 500),
          });
        }
      }

      const detail = await safeReadBody(response);
      lastError = new VintedApiError(errorMessageFor(response.status, detail), {
        status: response.status,
        path,
        method,
        body: detail,
      });

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw lastError;
    }
    throw lastError;
  }

  /**
   * Try several known paths, return the first that answers.
   *
   * `fallbackOn` lists the statuses that mean "try the next variant". 404 is
   * always one. Reads that identify the account also fall back on 401/403,
   * because a route Vinted has retired can answer 403 rather than 404 — and
   * giving up there would report a session problem the user does not have.
   */
  async requestFirst(paths, { fallbackOn = [404], ...options } = {}) {
    const retryable = new Set([404, ...fallbackOn]);
    let lastError = null;
    for (const path of paths) {
      try {
        return await this.request(path, options);
      } catch (error) {
        if (error instanceof VintedApiError && retryable.has(error.status)) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    if (lastError && paths.length > 1) {
      lastError.attemptedPaths = paths;
      lastError.message = `${lastError.message} — ook geprobeerd: ${paths
        .filter((path) => path !== lastError.path)
        .map((path) => path.split('?')[0])
        .join(', ')}`;
    }
    throw lastError ?? new VintedApiError('Geen bruikbaar endpoint gevonden.', { path: paths[0] });
  }

  // ---------------------------------------------------------------- reads --

  /**
   * Used by the connection test. These routes do work, but only with the
   * Accept header — without it Rails serves the HTML page and they look dead.
   * The normal path still resolves the account id from the page itself
   * (src/lib/user-id.js), which needs no request at all.
   */
  async getCurrentUser({ signal } = {}) {
    const data = await this.requestFirst(['/api/v2/users/current', '/api/v2/user'], {
      signal,
      fallbackOn: [401, 403],
    });
    return data?.user ?? data ?? null;
  }

  /**
   * One page of the signed-in user's own wardrobe.
   * @returns {{items: any[], pagination: any}}
   */
  async listOwnItems(userId, { page = 1, perPage = 20, signal } = {}) {
    const query = `page=${page}&per_page=${perPage}&order=relevance`;
    const data = await this.requestFirst(
      [
        `/api/v2/wardrobe/${userId}/items?${query}`,
        `/api/v2/users/${userId}/items?${query}`,
      ],
      { signal, fallbackOn: [401, 403] },
    );
    return {
      items: data?.items ?? [],
      pagination: data?.pagination ?? null,
    };
  }

  /**
   * Full detail for one item. The upload-form endpoint is preferred because it
   * returns exactly the fields the create endpoint expects.
   */
  async getItem(itemId, { signal } = {}) {
    const data = await this.requestFirst(
      [`/api/v2/item_upload/items/${itemId}`, `/api/v2/items/${itemId}`],
      { signal },
    );
    return data?.item ?? data ?? null;
  }

  /**
   * Walk the read endpoints one by one and report what each one answers,
   * without throwing. Because these endpoints are undocumented and can change,
   * "it does not work" needs to become "this exact call returns this status".
   */
  async diagnose({ signal } = {}) {
    const report = {
      origin: this.origin,
      hasCsrfToken: Boolean(this.csrfToken),
      locale: this.locale,
      hasAnonId: Boolean(this.anonId),
      hasCookies: Boolean(globalThis.document?.cookie),
      cookieNames: VintedApi.cookieNames(),
      userId: null,
      itemCount: null,
      checks: [],
    };

    const attempt = async (label, path) => {
      try {
        const data = await this.request(path, { signal });
        report.checks.push({ label, path, status: 200, ok: true });
        return data;
      } catch (error) {
        report.checks.push({
          label,
          path,
          status: error?.status ?? 0,
          ok: false,
          detail: describeFailure(error),
          blocked: Boolean(error?.isBlockPage),
        });
        return null;
      }
    };

    for (const path of ['/api/v2/users/current', '/api/v2/user']) {
      const data = await attempt('Ingelogde gebruiker', path);
      const id = data?.user?.id ?? data?.id ?? null;
      if (id) {
        report.userId = id;
        break;
      }
    }

    if (report.userId) {
      const query = 'page=1&per_page=1';
      for (const path of [
        `/api/v2/wardrobe/${report.userId}/items?${query}`,
        `/api/v2/users/${report.userId}/items?${query}`,
      ]) {
        const data = await attempt('Eigen advertenties', path);
        if (data?.items) {
          report.itemCount = data.pagination?.total_entries ?? data.items.length;
          break;
        }
      }
    }

    return report;
  }

  // --------------------------------------------------------------- photos --

  /** Download an existing item photo so it can be re-uploaded. */
  async downloadPhoto(url, { signal } = {}) {
    const response = await this.throttle.run(
      () => this.fetchImpl(url, { credentials: 'omit', signal }),
      { signal },
    );
    if (!response.ok) {
      throw new VintedApiError(`Foto downloaden mislukt (${response.status}).`, {
        status: response.status,
        path: url,
      });
    }
    const blob = await response.blob();
    if (!blob.size) {
      throw new VintedApiError('Foto downloaden leverde een leeg bestand op.', { path: url });
    }
    return blob;
  }

  /**
   * Upload one photo to the temporary upload session.
   * @returns {Promise<{id: number}>}
   */
  async uploadPhoto(blob, { tempUuid, filename = 'photo.jpg', signal } = {}) {
    const form = new FormData();
    form.append('photo[type]', 'item_photo');
    form.append('photo[temp_uuid]', tempUuid);
    form.append('photo[file]', blob, filename);

    // Content-Type must be left to the browser so the multipart boundary is set.
    const data = await this.request('/api/v2/photos', {
      method: 'POST',
      body: form,
      signal,
    });
    const id = data?.id ?? data?.photo?.id;
    if (!id) {
      throw new VintedApiError('Vinted gaf geen foto-id terug na het uploaden.', {
        path: '/api/v2/photos',
        body: data,
      });
    }
    return { id, orientation: data?.orientation ?? 0 };
  }

  // --------------------------------------------------------------- writes --

  /** Create a new listing. Returns the created item. */
  async createItem(payload, { signal } = {}) {
    const data = await this.request('/api/v2/item_upload/items', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
      signal,
    });
    const item = data?.item ?? data;
    if (!item?.id) {
      throw new VintedApiError('Vinted maakte geen nieuwe advertentie aan.', {
        path: '/api/v2/item_upload/items',
        body: data,
      });
    }
    return item;
  }

  /** Delete a listing. Vinted has used both a DELETE and a POST route. */
  async deleteItem(itemId, { signal } = {}) {
    try {
      await this.request(`/api/v2/items/${itemId}`, { method: 'DELETE', signal });
      return true;
    } catch (error) {
      const notRouted =
        error instanceof VintedApiError && (error.status === 404 || error.status === 405);
      if (!notRouted) throw error;
    }
    await this.request(`/api/v2/items/${itemId}/delete`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
      signal,
    });
    return true;
  }
}

/** One readable line about a failed call — never a dump of raw markup. */
function describeFailure(error) {
  if (error?.isBlockPage) {
    const title = error.body?.title;
    return `geblokkeerd — Vinted stuurde een webpagina terug${title ? ` ("${title}")` : ''}`;
  }
  if (typeof error?.body === 'string') return error.body.slice(0, 200);
  return error?.body?.message || error?.message || null;
}

async function safeReadBody(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return asHtmlMarker(text) ?? text.slice(0, 500);
    }
  } catch {
    return null;
  }
}

function errorMessageFor(status, detail) {
  if (detail && typeof detail === 'object' && detail.__html) {
    return (
      'Vinted antwoordde met een webpagina in plaats van API-gegevens — het verzoek is ' +
      'geblokkeerd door de beveiliging van de site, niet door een verlopen sessie.'
    );
  }
  const serverMessage =
    (detail && typeof detail === 'object' && (detail.message || detail.error)) || null;
  if (status === 401 || status === 403) {
    return serverMessage || 'Niet ingelogd of sessie verlopen — log opnieuw in op Vinted.';
  }
  if (status === 404) return serverMessage || 'Niet gevonden (404).';
  if (status === 422) return serverMessage || 'Vinted weigerde de gegevens (422).';
  if (status === 429) return serverMessage || 'Te veel verzoeken — Vinted remt af (429).';
  if (status >= 500) return serverMessage || `Serverfout bij Vinted (${status}).`;
  return serverMessage || `Verzoek mislukt (${status}).`;
}
