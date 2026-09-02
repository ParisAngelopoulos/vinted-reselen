/**
 * Content script running on vinted.* pages.
 *
 * All Vinted API traffic happens here, in the page's own origin, so the normal
 * session cookies apply and no credentials are ever read, copied or sent
 * anywhere else. The popup and the service worker only send commands and
 * receive progress updates.
 *
 * Declared content scripts cannot be ES modules, so the shared library is
 * pulled in with a dynamic import of extension-local files.
 */

(async () => {
  const base = (path) => chrome.runtime.getURL(path);

  const [
    { VintedApi, UPLOAD_FIELD_NAMES },
    { relistBatch, summarise, filenameFor },
    { MSG },
    { loadSettings },
    { saveBackup },
    { normalizeItem },
    { recordObserved, listObserved },
    { parseMemberIdFromPath, resolveUserId },
    { uuid },
    { reencodeImage, renameForType },
  ] = await Promise.all([
    import(base('src/lib/api.js')),
    import(base('src/lib/relist.js')),
    import(base('src/lib/messages.js')),
    import(base('src/lib/settings.js')),
    import(base('src/lib/backup.js')),
    import(base('src/lib/item-mapper.js')),
    import(base('src/lib/observed.js')),
    import(base('src/lib/user-id.js')),
    import(base('src/lib/uuid.js')),
    import(base('src/lib/image.js')),
  ]);

  /** @type {AbortController|null} */
  let activeRun = null;

  const send = (type, payload) => {
    // The popup may be closed; a missing receiver is not an error here.
    chrome.runtime.sendMessage({ type, payload }).catch(() => {});
  };

  function guardUnload(event) {
    event.preventDefault();
    event.returnValue = '';
    return '';
  }

  /** The token the site was seen using, if the recorder has caught one yet. */
  async function capturedCsrfToken() {
    try {
      const response = await chrome.runtime.sendMessage({ type: MSG.GET_CSRF });
      return response?.ok ? response.data?.token ?? null : null;
    } catch {
      return null;
    }
  }

  async function makeApi() {
    const settings = await loadSettings();
    const api = VintedApi.fromPage({ minGapMs: settings.delayBetweenCallsMs ?? 900 });
    // Reading the token off the page only works when the front-end puts it
    // there. What the site actually sends is authoritative, so it wins.
    api.csrfToken = (await capturedCsrfToken()) ?? api.csrfToken;
    if (!api.origin) throw new Error('Kon de Vinted-origin niet bepalen.');
    return { api, settings };
  }

  /**
   * Which account to list. GET /api/v2/users/current is retired — the site no
   * longer calls it and it answers with a protection page — so the id comes
   * from the profile URL, an earlier visit, or the traffic the site itself
   * made. See src/lib/user-id.js.
   */
  async function currentUserId(api = null) {
    const settings = await loadSettings();
    const [{ knownUserId }, observed] = await Promise.all([
      chrome.storage.local.get('knownUserId'),
      listObserved(),
    ]);

    let resolved = resolveUserId({
      override: settings.userId,
      remembered: knownUserId,
      pathname: location.pathname,
      observed,
    });

    // Only worth a request when nothing cheaper answered.
    if (!resolved.id && api) {
      const user = await api.getCurrentUser().catch(() => null);
      resolved = resolveUserId({ apiUserId: user?.id });
      if (resolved.id) await chrome.storage.local.set({ knownUserId: resolved.id });
    }

    if (!resolved.id) {
      throw new Error(
        'Kon je Vinted gebruikers-id niet bepalen. Open je eigen profielpagina ' +
          '(de pagina met je advertenties) en probeer opnieuw, of vul het id in bij de instellingen.',
      );
    }
    return resolved;
  }

  /**
   * How our photo upload compares to the one the site itself makes. Relisting
   * cannot work until this matches, and until the site has been seen uploading
   * once there is nothing to compare against.
   */
  async function compareUploadShape() {
    const observed = await listObserved();
    const row = observed.find((entry) => /POST \/api\/v\d+\/photos/.test(entry.entry));
    if (!row?.fields?.length) {
      return { seen: false, ours: UPLOAD_FIELD_NAMES };
    }
    // Rows may carry "name=value" for this endpoint; compare on the names.
    const theirs = row.fields.map((field) =>
      field.replace(/ \(bestand\)$/, '').replace(/=.*$/, ''),
    );
    const theirType = row.fields
      .find((field) => field.startsWith('photo[type]='))
      ?.split('=')[1] ?? null;
    return {
      seen: true,
      status: row.status,
      theirs,
      ours: UPLOAD_FIELD_NAMES,
      missing: theirs.filter((field) => !UPLOAD_FIELD_NAMES.includes(field)),
      extra: UPLOAD_FIELD_NAMES.filter((field) => !theirs.includes(field)),
      // Order is part of a multipart body; comparing the names as a set alone
      // reported "matches" while the file sat in a different position.
      sameOrder: theirs.join('|') === UPLOAD_FIELD_NAMES.join('|'),
      theirType,
      headers: row.headers ?? [],
    };
  }

  /**
   * Actually try one photo upload, because that is the step that breaks and a
   * connection test that only exercises reads reports "all green" while
   * relisting fails. The photo goes to a temporary upload session: nothing is
   * listed, nothing is deleted, and the session expires on its own.
   */
  async function probeUpload(api) {
    try {
      const user = await currentUserId(api);
      const { items } = await api.listOwnItems(user.id, { page: 1, perPage: 1 });
      if (!items.length) return { ok: false, reason: 'geen advertentie om mee te testen' };

      const item = normalizeItem(await api.getItem(items[0].id));
      const photo = item.photos[0];
      if (!photo) return { ok: false, reason: 'die advertentie heeft geen foto' };

      const blob = await api.downloadPhoto(photo.url);
      const filename = filenameFor(0, photo.url, blob);
      const size = await imageSize(blob);
      const shared = {
        pageUrl: location.pathname,
        filename,
        type: blob.type || 'onbekend',
        sizeKb: Math.round((blob.size || 0) / 1024),
        dimensions: size ? `${size.width}×${size.height}` : 'onbekend',
        photoSource: photo.source,
        photoFields: photo.available,
      };

      try {
        const result = await api.uploadPhoto(blob, { tempUuid: uuid(), filename });
        return { ok: true, photoId: result.id, ...shared };
      } catch (error) {
        // If Vinted refuses the file because it recognises one of its own,
        // a re-encoded copy — same picture, different bytes — goes through.
        // Trying both in one run settles that without guessing.
        const retry = await probeReencoded(api, blob, filename);
        return { ok: false, error: error.message, retry, ...shared };
      }
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** Second attempt with the same picture re-encoded, to test that theory. */
  async function probeReencoded(api, blob, filename) {
    try {
      const { blob: encoded, extension } = await reencodeImage(blob);
      const name = renameForType(filename, extension);
      const result = await api.uploadPhoto(encoded, { tempUuid: uuid(), filename: name });
      return {
        ok: true,
        photoId: result.id,
        filename: name,
        type: encoded.type,
        sizeKb: Math.round(encoded.size / 1024),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * Pixel dimensions of what we are about to upload. A photo URL that quietly
   * serves a thumbnail produces a plausible-looking JPEG that Vinted refuses,
   * and the byte size alone does not reveal that.
   */
  async function imageSize(blob) {
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    } catch {
      return null;
    }
  }

  async function handleListItems({ page = 1, perPage = 20 } = {}) {
    const { api } = await makeApi();
    const user = await currentUserId(api);
    const { items, pagination } = await api.listOwnItems(user.id, { page, perPage });
    return {
      user: { id: user.id, source: user.source },
      pagination,
      items: items.map((raw) => {
        const item = normalizeItem(raw);
        return {
          id: item.id,
          title: item.title,
          price: item.price,
          currency: item.currency,
          photo: item.photos[0]?.url ?? null,
          isSold: item.isSold,
          isReserved: item.isReserved,
          isHidden: item.isHidden,
          createdAtTs: item.createdAtTs,
        };
      }),
    };
  }

  async function handleStart({ itemIds = [], trigger = 'manual' } = {}) {
    if (activeRun) throw new Error('Er loopt al een sessie in dit tabblad.');
    if (!itemIds.length) throw new Error('Geen items geselecteerd.');

    const { api, settings } = await makeApi();
    activeRun = new AbortController();
    window.addEventListener('beforeunload', guardUnload);

    send(MSG.PROGRESS, {
      kind: 'run-started',
      total: Math.min(itemIds.length, settings.maxItemsPerRun || itemIds.length),
      trigger,
    });

    try {
      const results = await relistBatch(api, itemIds, {
        settings,
        signal: activeRun.signal,
        // Canvas lives in the page context, so the engine gets it injected
        // rather than importing browser-only code itself.
        hooks: { saveBackup, reencodeImage },
        onProgress: (update) => send(MSG.PROGRESS, { kind: 'step', ...update }),
        onItemDone: (result) => send(MSG.PROGRESS, { kind: 'item-done', result }),
      });
      send(MSG.FINISHED, { results, summary: summarise(results) });
      return { results, summary: summarise(results) };
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      send(MSG.FINISHED, {
        results: [],
        summary: null,
        error: aborted ? 'Gestopt door gebruiker.' : error.message,
        aborted,
      });
      throw error;
    } finally {
      window.removeEventListener('beforeunload', guardUnload);
      activeRun = null;
    }
  }

  function handleCancel() {
    if (!activeRun) return { cancelled: false };
    activeRun.abort();
    return { cancelled: true };
  }

  // Tell the worker which Vinted site this user is on, so it can reopen the
  // right domain later even when no Vinted tab is left open.
  send(MSG.HELLO, { origin: location.origin });

  // Being on a profile page is the one moment the account id is available for
  // free — no API call, no guessing. Remember it for later.
  const idFromPath = parseMemberIdFromPath(location.pathname);
  if (idFromPath) chrome.storage.local.set({ knownUserId: idFromPath });

  // The recorder runs in the page's own context and cannot reach chrome.*, so
  // relay what it sees. Endpoint records carry only a method, a path, query
  // parameter names and a status code — no values. The one exception is the
  // CSRF token, which is deliberately captured because writes are refused
  // without it; it goes to the worker's memory-only session storage and never
  // leaves this machine.
  const RECORDER_CHANNEL = 'vinted-relister-recorder';
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== RECORDER_CHANNEL || message.ready) return;

    if (message.csrfToken) {
      chrome.runtime
        .sendMessage({ type: MSG.SET_CSRF, payload: { token: message.csrfToken } })
        .catch(() => {});
      return;
    }

    recordObserved({
      entry: message.entry,
      status: message.status,
      headers: message.headers,
      fields: message.fields,
    }).catch(() => {});
  });
  // Ask the recorder to replay whatever it saw before this listener existed.
  window.postMessage({ source: RECORDER_CHANNEL, ready: true }, location.origin);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handlers = {
      [MSG.PING]: async () => ({ ok: true, origin: location.origin, busy: Boolean(activeRun) }),
      [MSG.LIST_ITEMS]: () => handleListItems(message.payload),
      [MSG.DIAGNOSE]: async () => {
        const { api } = await makeApi();
        const report = await api.diagnose();
        // The account id no longer comes from the API, so report separately
        // how it was resolved — that is what actually decides whether the
        // extension can list anything.
        try {
          const user = await currentUserId(api);
          report.resolvedUserId = user.id;
          report.userIdSource = user.source;
        } catch (error) {
          report.resolvedUserId = null;
          report.userIdSource = error.message;
        }
        // Which page the upload ran from decides the Referer the browser
        // attaches — script cannot set that header, so the page matters.
        report.pageUrl = location.pathname;
        report.upload = await compareUploadShape();
        report.uploadProbe = await probeUpload(api);
        return report;
      },
      [MSG.START]: () => handleStart(message.payload),
      [MSG.CANCEL]: async () => handleCancel(),
    };

    const handler = handlers[message?.type];
    if (!handler) return false;

    Promise.resolve()
      .then(handler)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true; // keep the channel open for the async response
  });
})();
