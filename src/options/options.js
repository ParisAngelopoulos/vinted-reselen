import { DEFAULT_SETTINGS, loadSettings, resetSettings, saveSettings } from '../lib/settings.js';
import { clearBackups, listBackups } from '../lib/backup.js';

const form = document.getElementById('form');
const status = document.getElementById('status');
const priceValueField = document.getElementById('price-value-field');

function applySettings(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value;
  }
  togglePriceValue();
}

function readSettings() {
  const next = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;
    if (field.type === 'checkbox') next[key] = field.checked;
    else if (field.type === 'number') {
      const parsed = Number(field.value);
      next[key] = Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS[key];
    } else next[key] = field.value;
  }
  return next;
}

function togglePriceValue() {
  const mode = form.elements.namedItem('priceMode').value;
  priceValueField.hidden = mode === 'keep';
}

function flash(message) {
  status.textContent = message;
  setTimeout(() => {
    status.textContent = '';
  }, 2500);
}

async function refreshBackupCount() {
  const backups = await listBackups();
  const label = document.getElementById('backup-count');
  label.textContent = backups.length
    ? `${backups.length} back-up(s) bewaard, oudste van ${new Date(backups.at(-1).savedAt).toLocaleDateString('nl-NL')}.`
    : 'Nog geen back-ups.';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveSettings(readSettings());
  flash('Opgeslagen.');
});

form.elements.namedItem('priceMode').addEventListener('change', togglePriceValue);

document.getElementById('reset').addEventListener('click', async () => {
  const settings = await resetSettings();
  applySettings(settings);
  flash('Standaardwaarden hersteld.');
});

document.getElementById('export-backups').addEventListener('click', async () => {
  const backups = await listBackups();
  const blob = new Blob([JSON.stringify(backups, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `vinted-relister-backups-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

document.getElementById('clear-backups').addEventListener('click', async () => {
  if (!window.confirm('Alle lokale back-ups wissen?')) return;
  await clearBackups();
  await refreshBackupCount();
  flash('Back-ups gewist.');
});

(async function init() {
  applySettings(await loadSettings());
  await refreshBackupCount();
})();
