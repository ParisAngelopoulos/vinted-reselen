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
  constructor(message, { status = 0, path = '', body = null } = {}) {
    super(message);
    this.name = 'VintedApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }

  get isAuth() {
    return this.status === 401 || this.status === 403;
  }

  get isRateLimit() {
    return this.status === 429;
  }
}

const JSON_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
};

export class VintedApi {
  /**
   * @param {object} opts
   * @param {string} opts.origin      e.g. "https://www.vinted.nl"
   * @param {string} [opts.csrfToken] value of the page's CSRF meta tag
   * @param {number} [opts.minGapMs]  minimum gap between requests
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({ origin, csrfToken = null, minGapMs = 900, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.origin = (origin || globalThis.location?.origin || '').replace(/\/$/, '');
    this.csrfToken = csrfToken;
    this.fetchImpl = fetchImpl;
    this.throttle = new Throttle(minGapMs);
    this.maxRetries = 3;
  }

  /** Read the CSRF token the way the Vinted front-end does. */
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
    return null;
  }

  static fromPage(overrides = {}) {
    return new VintedApi({
      origin: globalThis.location?.origin,
      csrfToken: VintedApi.readCsrfToken(),
      ...overrides,
    });
  }

  setGap(ms) {
    this.throttle.setGap(ms);
  }

  headers(extra = {}) {
    const headers = { ...extra };
    if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
    // Mirrors the header the web app sends; some routes 403 without it.
    headers['X-Requested-With'] = 'XMLHttpRequest';
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
            body: text.slice(0, 500),
          });
        }
      }

      const detail = await safeReadBody(response);
      lastError = new VintedApiError(errorMessageFor(response.status, detail), {
        status: response.status,
        path,
        body: detail,
      });

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw lastError;
    }
    throw lastError;
  }

  /** Try several known paths, return the first that answers. */
  async requestFirst(paths, options) {
    let lastError = null;
    for (const path of paths) {
      try {
        return await this.request(path, options);
      } catch (error) {
        if (error instanceof VintedApiError && error.status === 404) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new VintedApiError('Geen bruikbaar endpoint gevonden.', { path: paths[0] });
  }

  // ---------------------------------------------------------------- reads --

  async getCurrentUser({ signal } = {}) {
    const data = await this.requestFirst(['/api/v2/users/current', '/api/v2/user'], { signal });
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
      { signal },
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

async function safeReadBody(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return null;
  }
}

function errorMessageFor(status, detail) {
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
