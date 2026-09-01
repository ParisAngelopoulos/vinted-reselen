import { DEFAULT_SETTINGS, loadSettings, resetSettings, saveSettings } from '../lib/settings.js';
import { clearBackups, listBackups } from '../lib/backup.js';
import { MSG } from '../lib/messages.js';

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

/** Turns "it does not work" into a report naming the exact failing call. */
function formatDiagnosis(report) {
  const lines = [
    `Site:            ${report.origin}`,
    `Cookies:         ${report.hasCookies ? 'aanwezig' : 'GEEN — je bent niet ingelogd op deze site'}`,
    `anon_id-cookie:  ${report.hasAnonId ? 'aanwezig' : 'ontbreekt'}`,
    `CSRF-token:      ${report.hasCsrfToken ? 'gevonden' : 'niet gevonden op de pagina'}`,
    '',
  ];

  for (const check of report.checks) {
    const mark = check.ok ? '✓' : '✗';
    lines.push(`${mark} ${check.label}: ${check.status || 'geen antwoord'}  ${check.path}`);
    if (check.detail) lines.push(`    ${check.detail}`);
  }

  lines.push('');
  if (report.userId) {
    lines.push(`Ingelogd als gebruiker ${report.userId}.`);
    lines.push(
      report.itemCount === null
        ? 'Je advertenties konden niet worden opgehaald — zie de regel met ✗ hierboven.'
        : `${report.itemCount} advertentie(s) gevonden. De extensie hoort te werken.`,
    );
  } else {
    lines.push('Vinted geeft geen ingelogde gebruiker terug. Log opnieuw in op deze site en test nogmaals.');
  }
  return lines.join('\n');
}

document.getElementById('run-diagnose').addEventListener('click', async () => {
  const output = document.getElementById('diagnose-output');
  const button = document.getElementById('run-diagnose');
  output.hidden = false;
  output.textContent = 'Bezig met testen…';
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.DIAGNOSE });
    if (!response?.ok) throw new Error(response?.error || 'Geen antwoord van de extensie.');
    output.textContent = formatDiagnosis(response.data);
  } catch (error) {
    output.textContent = `De test kon niet worden uitgevoerd:\n${error.message}`;
  } finally {
    button.disabled = false;
  }
});

(async function init() {
  applySettings(await loadSettings());
  await refreshBackupCount();
})();
