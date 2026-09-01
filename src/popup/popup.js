/**
 * Popup: pick listings, start a run, watch it. All work is delegated to the
 * service worker so closing the popup never interrupts a session.
 */

import { EMPTY_RUN_STATE, MSG, RUN_STATE_KEY } from '../lib/messages.js';
import { loadSettings } from '../lib/settings.js';

const el = (id) => document.getElementById(id);
const ui = {
  notice: el('notice'),
  items: el('items'),
  empty: el('empty'),
  loading: el('loading'),
  loadMore: el('load-more'),
  selectAll: el('select-all'),
  selectionCount: el('selection-count'),
  refresh: el('refresh'),
  start: el('start'),
  cancel: el('cancel'),
  runPanel: el('run-panel'),
  progress: el('progress'),
  progressLabel: el('progress-label'),
  currentMessage: el('current-message'),
  logPanel: el('log-panel'),
  log: el('log'),
  toggleLog: el('toggle-log'),
  options: el('open-options'),
};

const state = {
  items: [],
  selected: new Set(),
  page: 1,
  hasMore: false,
  settings: null,
};

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload }).then((response) => {
    if (!response) throw new Error('Geen antwoord van de extensie.');
    if (!response.ok) throw new Error(response.error);
    return response.data;
  });
}

function showNotice(message, kind = 'warn') {
  ui.notice.textContent = message;
  ui.notice.className = `notice ${kind === 'error' ? 'error' : ''}`;
  ui.notice.hidden = !message;
}

function clearNotice() {
  ui.notice.hidden = true;
}

// ------------------------------------------------------------------ list ---

function itemBlockedReason(item) {
  if (item.isSold) return 'verkocht';
  if (item.isReserved && state.settings?.skipReserved !== false) return 'gereserveerd';
  return null;
}

function renderItems() {
  ui.items.replaceChildren();
  ui.empty.hidden = state.items.length > 0;

  for (const item of state.items) {
    const blocked = itemBlockedReason(item);
    const li = document.createElement('li');
    li.className = `item${blocked ? ' blocked' : ''}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(item.id);
    checkbox.disabled = Boolean(blocked);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(item.id);
      else state.selected.delete(item.id);
      updateSelectionUi();
    });

    const img = document.createElement('img');
    if (item.photo) img.src = item.photo;
    img.alt = '';

    const body = document.createElement('div');
    body.className = 'item-body';

    const title = document.createElement('span');
    title.className = 'item-title';
    title.textContent = item.title || `Item ${item.id}`;

    const meta = document.createElement('span');
    meta.className = 'item-meta';
    meta.textContent = item.price ? `${item.price} ${item.currency}` : 'geen prijs';
    if (blocked) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = blocked;
      meta.append(tag);
    }

    body.append(title, meta);
    li.append(checkbox, img, body);
    ui.items.append(li);
  }
  updateSelectionUi();
}

function updateSelectionUi() {
  const count = state.selected.size;
  ui.selectionCount.textContent = `${count} geselecteerd`;
  const selectable = state.items.filter((item) => !itemBlockedReason(item));
  ui.selectAll.checked = selectable.length > 0 && count === selectable.length;
  ui.selectAll.indeterminate = count > 0 && count < selectable.length;
  refreshStartButton();
}

function refreshStartButton(active = ui.runPanel.hidden === false) {
  ui.start.disabled = state.selected.size === 0 || active;
}

async function loadItems({ append = false } = {}) {
  ui.loading.hidden = false;
  ui.loadMore.hidden = true;
  try {
    const data = await send(MSG.LIST_ITEMS, { page: state.page, perPage: 24 });
    clearNotice();
    state.items = append ? [...state.items, ...data.items] : data.items;
    const pagination = data.pagination;
    state.hasMore = Boolean(pagination && pagination.current_page < pagination.total_pages);
    ui.loadMore.hidden = !state.hasMore;
    renderItems();
  } catch (error) {
    showNotice(error.message, 'error');
    ui.empty.hidden = state.items.length > 0;
  } finally {
    ui.loading.hidden = true;
  }
}

// ------------------------------------------------------------------- run ---

function renderRunState(runState) {
  const active = Boolean(runState.active);
  ui.runPanel.hidden = !active;
  ui.refresh.disabled = active;
  refreshStartButton(active);

  const total = runState.total || 0;
  const done = runState.done || 0;
  ui.progress.max = Math.max(total, 1);
  ui.progress.value = done;
  ui.progressLabel.textContent = `${done} / ${total}`;
  ui.currentMessage.textContent = runState.currentMessage || '';

  ui.log.replaceChildren();
  for (const entry of runState.log || []) {
    const li = document.createElement('li');
    li.className = entry.level || 'info';
    const time = new Date(entry.at).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.textContent = `${time} — ${entry.line}`;
    ui.log.append(li);
  }
  ui.log.lastElementChild?.scrollIntoView({ block: 'nearest' });

  if (!active && runState.error) showNotice(runState.error, 'error');
}

async function refreshRunState() {
  const runState = await send(MSG.GET_STATE).catch(() => ({ ...EMPTY_RUN_STATE }));
  renderRunState(runState);
  return runState;
}

// -------------------------------------------------------------- handlers ---

ui.selectAll.addEventListener('change', () => {
  state.selected.clear();
  if (ui.selectAll.checked) {
    for (const item of state.items) {
      if (!itemBlockedReason(item)) state.selected.add(item.id);
    }
  }
  renderItems();
});

ui.refresh.addEventListener('click', () => {
  state.page = 1;
  state.selected.clear();
  loadItems();
});

ui.loadMore.addEventListener('click', () => {
  state.page += 1;
  loadItems({ append: true });
});

ui.start.addEventListener('click', async () => {
  const itemIds = [...state.selected];
  const settings = state.settings || (await loadSettings());
  const cap = Number(settings.maxItemsPerRun) || itemIds.length;
  const planned = Math.min(itemIds.length, cap);

  const mode = settings.dryRun ? 'TESTMODUS (er wordt niets gewijzigd)' : 'Dit verwijdert de oude advertenties.';
  const confirmed = window.confirm(
    `${planned} advertentie(s) opnieuw plaatsen?\n\n${mode}\n\n` +
      `Volgorde: ${settings.order === 'delete-first' ? 'eerst verwijderen, dan plaatsen' : 'eerst plaatsen, dan verwijderen'}.`,
  );
  if (!confirmed) return;

  try {
    ui.start.disabled = true;
    await send(MSG.START, { itemIds, trigger: 'manual' });
    clearNotice();
    await refreshRunState();
  } catch (error) {
    showNotice(error.message, 'error');
    refreshStartButton(false);
  }
});

ui.cancel.addEventListener('click', async () => {
  ui.cancel.disabled = true;
  try {
    await send(MSG.CANCEL);
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    ui.cancel.disabled = false;
    await refreshRunState();
  }
});

ui.toggleLog.addEventListener('click', () => {
  ui.logPanel.hidden = !ui.logPanel.hidden;
});

ui.options.addEventListener('click', () => chrome.runtime.openOptionsPage());

// Live updates while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[RUN_STATE_KEY]) {
    renderRunState({ ...EMPTY_RUN_STATE, ...changes[RUN_STATE_KEY].newValue });
  }
});

(async function init() {
  el('app-version').textContent = `v${chrome.runtime.getManifest().version}`;
  state.settings = await loadSettings();
  if (state.settings.dryRun) {
    showNotice('Testmodus staat aan — er wordt niets aangemaakt of verwijderd.');
  }
  await refreshRunState();
  await loadItems();
})();
