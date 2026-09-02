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
    { VintedApi },
    { relistBatch, summarise },
    { MSG },
    { loadSettings },
    { saveBackup },
    { normalizeItem },
    { recordObserved, listObserved },
    { parseMemberIdFromPath, resolveUserId },
  ] = await Promise.all([
    import(base('src/lib/api.js')),
    import(base('src/lib/relist.js')),
    import(base('src/lib/messages.js')),
    import(base('src/lib/settings.js')),
    import(base('src/lib/backup.js')),
    import(base('src/lib/item-mapper.js')),
    import(base('src/lib/observed.js')),
    import(base('src/lib/user-id.js')),
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
  async function currentUserId() {
    const settings = await loadSettings();
    const [{ knownUserId }, observed] = await Promise.all([
      chrome.storage.local.get('knownUserId'),
      listObserved(),
    ]);

    const resolved = resolveUserId({
      override: settings.userId,
      remembered: knownUserId,
      pathname: location.pathname,
      observed,
    });

    if (!resolved.id) {
      throw new Error(
        'Kon je Vinted gebruikers-id niet bepalen. Open je eigen profielpagina ' +
          '(de pagina met je advertenties) en probeer opnieuw, of vul het id in bij de instellingen.',
      );
    }
    return resolved;
  }

  async function handleListItems({ page = 1, perPage = 20 } = {}) {
    const { api } = await makeApi();
    const user = await currentUserId();
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
        hooks: { saveBackup },
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
          const user = await currentUserId();
          report.resolvedUserId = user.id;
          report.userIdSource = user.source;
        } catch (error) {
          report.resolvedUserId = null;
          report.userIdSource = error.message;
        }
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
