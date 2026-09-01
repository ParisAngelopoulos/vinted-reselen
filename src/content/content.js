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

  const [{ VintedApi }, { relistBatch, summarise }, { MSG }, { loadSettings }, { saveBackup }, { normalizeItem }] =
    await Promise.all([
      import(base('src/lib/api.js')),
      import(base('src/lib/relist.js')),
      import(base('src/lib/messages.js')),
      import(base('src/lib/settings.js')),
      import(base('src/lib/backup.js')),
      import(base('src/lib/item-mapper.js')),
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

  async function makeApi() {
    const settings = await loadSettings();
    const api = VintedApi.fromPage({ minGapMs: settings.delayBetweenCallsMs ?? 900 });
    if (!api.origin) throw new Error('Kon de Vinted-origin niet bepalen.');
    return { api, settings };
  }

  async function handleListItems({ page = 1, perPage = 20 } = {}) {
    const { api } = await makeApi();
    const user = await api.getCurrentUser();
    if (!user?.id) {
      throw new Error('Niet ingelogd op Vinted. Log in en probeer opnieuw.');
    }
    const { items, pagination } = await api.listOwnItems(user.id, { page, perPage });
    return {
      user: { id: user.id, login: user.login ?? null },
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handlers = {
      [MSG.PING]: async () => ({ ok: true, origin: location.origin, busy: Boolean(activeRun) }),
      [MSG.LIST_ITEMS]: () => handleListItems(message.payload),
      [MSG.DIAGNOSE]: async () => {
        const { api } = await makeApi();
        return api.diagnose();
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
