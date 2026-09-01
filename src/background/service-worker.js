/**
 * Service worker: owns the run state and the schedule.
 *
 * The actual API work happens in the content script (page origin, page
 * cookies). This worker finds or opens a Vinted tab, forwards the command,
 * records progress so the popup can be closed and reopened mid-run, and drives
 * the optional scheduled relist through chrome.alarms.
 */

import { EMPTY_RUN_STATE, MSG, RUN_STATE_KEY } from '../lib/messages.js';
import { loadSettings } from '../lib/settings.js';
import { pruneBackups } from '../lib/backup.js';

const ALARM_SCHEDULE = 'relist-schedule';
const MAX_LOG_LINES = 200;

// ---------------------------------------------------------------- state ----

async function getRunState() {
  const store = await chrome.storage.local.get(RUN_STATE_KEY);
  return { ...EMPTY_RUN_STATE, ...(store[RUN_STATE_KEY] || {}) };
}

/**
 * Progress messages and the completion message arrive independently, so every
 * read-modify-write on the run state goes through this queue. Without it the
 * last progress update can be built on a snapshot taken before completion and
 * write `active: true` back over the finished state, leaving the extension
 * convinced a session is still running.
 */
let stateQueue = Promise.resolve();

function mutateRunState(mutator) {
  const result = stateQueue.then(async () => {
    const current = await getRunState();
    const patch = typeof mutator === 'function' ? mutator(current) : mutator;
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ [RUN_STATE_KEY]: next });
    return next;
  });
  // Keep the queue usable even if one mutation throws.
  stateQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function setRunState(patch) {
  return mutateRunState(patch);
}

function appendLog(line, level = 'info') {
  return mutateRunState((state) => ({
    log: [...state.log, { at: Date.now(), line, level }].slice(-MAX_LOG_LINES),
  }));
}

// ------------------------------------------------------------ tab lookup ---

const VINTED_TAB_QUERY = ['*://*.vinted.nl/*', '*://*.vinted.be/*', '*://*.vinted.de/*',
  '*://*.vinted.fr/*', '*://*.vinted.at/*', '*://*.vinted.lu/*', '*://*.vinted.es/*',
  '*://*.vinted.it/*', '*://*.vinted.pt/*', '*://*.vinted.pl/*', '*://*.vinted.cz/*',
  '*://*.vinted.sk/*', '*://*.vinted.lt/*', '*://*.vinted.com/*', '*://*.vinted.co.uk/*',
  '*://*.vinted.se/*', '*://*.vinted.dk/*', '*://*.vinted.fi/*', '*://*.vinted.gr/*',
  '*://*.vinted.ro/*', '*://*.vinted.hu/*', '*://*.vinted.hr/*', '*://*.vinted.ie/*'];

/** Fallback used only before any Vinted page has ever been seen. */
const FALLBACK_SITE = 'https://www.vinted.nl/';
const ORIGIN_KEY = 'lastVintedOrigin';

/**
 * The Vinted domain to open when no tab is available. Whichever site the user
 * actually browses wins over the fallback, so a .de or .be seller does not get
 * a .nl tab opened behind their back.
 */
async function defaultSite() {
  const store = await chrome.storage.local.get(ORIGIN_KEY);
  const origin = store[ORIGIN_KEY];
  return origin ? `${origin}/` : FALLBACK_SITE;
}

async function findVintedTab() {
  const tabs = await chrome.tabs.query({ url: VINTED_TAB_QUERY });
  // Prefer a tab in the focused window so the user can see what happens.
  const active = tabs.find((tab) => tab.active);
  return active || tabs[0] || null;
}

async function waitForContentScript(tabId, { attempts = 20, gapMs = 500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
      if (response?.ok) return response;
    } catch {
      /* content script not ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  throw new Error('Vinted-tabblad reageert niet. Open vinted.nl en probeer opnieuw.');
}

/**
 * Get a usable Vinted tab, opening one if needed.
 * @param {boolean} createIfMissing
 */
export async function ensureVintedTab(createIfMissing = true) {
  const existing = await findVintedTab();
  if (existing) {
    await waitForContentScript(existing.id);
    return existing;
  }
  if (!createIfMissing) {
    throw new Error('Geen Vinted-tabblad open.');
  }
  const tab = await chrome.tabs.create({ url: await defaultSite(), active: false });
  await waitForContentScript(tab.id);
  return tab;
}

async function sendToTab(tabId, type, payload) {
  const response = await chrome.tabs.sendMessage(tabId, { type, payload });
  if (!response) throw new Error('Geen antwoord van het Vinted-tabblad.');
  if (!response.ok) throw new Error(response.error || 'Onbekende fout.');
  return response.data;
}

// ------------------------------------------------------------ run driver ---

async function startRun({ itemIds, trigger = 'manual' }) {
  const state = await getRunState();
  if (state.active) throw new Error('Er loopt al een relist-sessie.');

  const tab = await ensureVintedTab(true);

  await mutateRunState(() => ({
    ...EMPTY_RUN_STATE,
    active: true,
    startedAt: Date.now(),
    total: itemIds.length,
    trigger,
    tabId: tab.id,
  }));

  // Fire and forget: progress arrives through runtime messages. Awaiting here
  // would keep the worker pinned for the whole run.
  sendToTab(tab.id, MSG.START, { itemIds, trigger }).catch(async (error) => {
    await appendLog(`Sessie afgebroken: ${error.message}`, 'error');
    await setRunState({ active: false, finishedAt: Date.now(), error: error.message });
  });

  return { started: true, tabId: tab.id, total: itemIds.length };
}

async function cancelRun() {
  const state = await getRunState();
  if (state.tabId) {
    try {
      await sendToTab(state.tabId, MSG.CANCEL);
    } catch {
      /* tab may be gone; fall through and clear the state anyway */
    }
  }
  await setRunState({ active: false, finishedAt: Date.now(), currentMessage: 'Gestopt.' });
  return { cancelled: true };
}

async function listItems(payload) {
  const tab = await ensureVintedTab(true);
  return sendToTab(tab.id, MSG.LIST_ITEMS, payload);
}

// --------------------------------------------------------------- routing ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    [MSG.GET_STATE]: () => getRunState(),
    [MSG.LIST_ITEMS]: () => listItems(message.payload),
    [MSG.START]: () => startRun(message.payload),
    [MSG.CANCEL]: () => cancelRun(),
  };

  // Progress and completion come from the content script: record them, and let
  // the popup pick them up either live or from storage when it reopens.
  if (message?.type === MSG.HELLO) {
    const origin = message.payload?.origin;
    if (origin) chrome.storage.local.set({ [ORIGIN_KEY]: origin });
    return false;
  }
  if (message?.type === MSG.PROGRESS) {
    handleProgress(message.payload).catch(() => {});
    return false;
  }
  if (message?.type === MSG.FINISHED) {
    handleFinished(message.payload).catch(() => {});
    return false;
  }

  const handler = handlers[message?.type];
  if (!handler) return false;

  Promise.resolve()
    .then(handler)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleProgress(payload = {}) {
  if (payload.kind === 'run-started') {
    await setRunState({ total: payload.total, done: 0 });
    await appendLog(`Sessie gestart voor ${payload.total} item(s).`);
    return;
  }
  if (payload.kind === 'item-done') {
    await mutateRunState((state) => {
      const results = [...state.results, payload.result];
      return { done: results.length, results };
    });
    return;
  }
  if (payload.kind === 'step') {
    await setRunState({ currentItemId: payload.itemId ?? null, currentMessage: payload.message || '' });
    if (payload.step === 'done' || payload.step === 'error') {
      await appendLog(payload.message, payload.step === 'error' ? 'error' : 'info');
    }
    return;
  }
}

async function handleFinished(payload = {}) {
  const { summary, error } = payload;
  await setRunState({
    active: false,
    finishedAt: Date.now(),
    currentItemId: null,
    currentMessage: error || 'Klaar.',
    error: error ?? null,
  });
  if (summary) {
    await appendLog(
      `Klaar — ${summary.relisted} opnieuw geplaatst, ${summary.skipped} overgeslagen, ${summary.failed} mislukt.`,
      summary.failed ? 'warn' : 'info',
    );
    await notify(
      'Relisten klaar',
      `${summary.relisted} opnieuw geplaatst, ${summary.skipped} overgeslagen, ${summary.failed} mislukt.`,
    );
  } else if (error) {
    await notify('Relisten gestopt', error);
  }
}

async function notify(title, message) {
  // A badge instead of a desktop notification: it needs no extra permission
  // and the popup's log already carries the detail.
  try {
    await chrome.action.setBadgeText({ text: '✓' });
    await chrome.action.setBadgeBackgroundColor({ color: '#09b1ba' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 15_000);
  } catch {
    /* badge is cosmetic */
  }
  console.info(`[Vinted Relister] ${title}: ${message}`);
}

// -------------------------------------------------------------- schedule ---

async function refreshSchedule() {
  const settings = await loadSettings();
  await chrome.alarms.clear(ALARM_SCHEDULE);
  if (!settings.scheduleEnabled) return;

  const minutes = Math.max(1, Number(settings.scheduleIntervalHours) || 24) * 60;
  await chrome.alarms.create(ALARM_SCHEDULE, {
    delayInMinutes: minutes,
    periodInMinutes: minutes,
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_SCHEDULE) return;
  try {
    const settings = await loadSettings();
    if (!settings.scheduleEnabled) return;

    await pruneBackups(settings.backupRetentionDays);

    const state = await getRunState();
    if (state.active) {
      await appendLog('Geplande sessie overgeslagen: er liep er al een.', 'warn');
      return;
    }

    // Pick the oldest listings first — those are the ones a relist helps most.
    const { items } = await listItems({ page: 1, perPage: 96 });
    const eligible = items
      .filter((item) => !item.isSold && !item.isReserved && !item.isHidden)
      .sort((a, b) => new Date(a.createdAtTs || 0) - new Date(b.createdAtTs || 0))
      .slice(0, Math.max(1, Number(settings.scheduleItemsPerRun) || 3))
      .map((item) => item.id);

    if (!eligible.length) {
      await appendLog('Geplande sessie: niets te doen.', 'info');
      return;
    }
    await startRun({ itemIds: eligible, trigger: 'schedule' });
  } catch (error) {
    await appendLog(`Geplande sessie mislukt: ${error.message}`, 'error');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) refreshSchedule().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => refreshSchedule().catch(() => {}));
chrome.runtime.onStartup.addListener(() => refreshSchedule().catch(() => {}));

// If the tab running a session disappears, the session is gone with it.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getRunState();
  if (state.active && state.tabId === tabId) {
    await appendLog('Tabblad gesloten — sessie afgebroken.', 'error');
    await setRunState({ active: false, finishedAt: Date.now(), error: 'Tabblad gesloten.' });
  }
});
