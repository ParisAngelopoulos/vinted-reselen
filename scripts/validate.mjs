/**
 * Static check of the extension bundle: every path the manifest, the HTML and
 * the JS modules point at must actually exist, and everything a content script
 * imports at runtime must be web-accessible.
 *
 * Chrome reports these mistakes as a blank popup or a silently dead service
 * worker, so it is worth catching them here.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const fail = (message) => problems.push(message);
const abs = (path) => join(ROOT, path);

function mustExist(path, context) {
  if (!existsSync(abs(path))) fail(`${context}: bestand ontbreekt → ${path}`);
}

// ------------------------------------------------------------- manifest ----

const manifest = JSON.parse(readFileSync(abs('manifest.json'), 'utf8'));

if (manifest.manifest_version !== 3) fail('manifest: verwacht manifest_version 3');

mustExist(manifest.background.service_worker, 'manifest.background');
if (manifest.background.type !== 'module') {
  fail('manifest.background: type moet "module" zijn, de worker gebruikt import');
}

for (const entry of manifest.content_scripts ?? []) {
  for (const file of entry.js ?? []) mustExist(file, 'manifest.content_scripts');
}
mustExist(manifest.action.default_popup, 'manifest.action');
mustExist(manifest.options_ui.page, 'manifest.options_ui');
for (const file of Object.values(manifest.icons ?? {})) mustExist(file, 'manifest.icons');
for (const file of Object.values(manifest.action?.default_icon ?? {})) {
  mustExist(file, 'manifest.action.default_icon');
}

// Content-script hosts need matching host_permissions, otherwise fetches from
// the page are blocked for cross-origin image downloads.
const hostPermissions = new Set(manifest.host_permissions ?? []);
for (const entry of manifest.content_scripts ?? []) {
  for (const match of entry.matches ?? []) {
    if (!hostPermissions.has(match)) fail(`host_permissions mist ${match}`);
  }
}

// ------------------------------------------------------- module imports ----

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const sourceFiles = walk(abs('src'));
const jsFiles = sourceFiles.filter((file) => file.endsWith('.js'));

const STATIC_IMPORT = /(?:^|\n)\s*import\s+(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
const RUNTIME_URL = /chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_BASE = /import\(\s*base\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;

const runtimeImported = new Set();

for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8');
  const here = dirname(file);

  for (const [, spec] of source.matchAll(STATIC_IMPORT)) {
    if (!spec.startsWith('.')) continue;
    const target = resolve(here, spec);
    if (!existsSync(target)) {
      fail(`${relative(ROOT, file)}: import verwijst naar niets → ${spec}`);
    }
  }

  for (const pattern of [RUNTIME_URL, IMPORT_BASE]) {
    for (const [, path] of source.matchAll(pattern)) {
      runtimeImported.add(path);
      mustExist(path, relative(ROOT, file));
    }
  }
}

// ------------------------------------------- web accessible resources ------

const warPatterns = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources);
const matchesWar = (path) =>
  warPatterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
    return regex.test(path);
  });

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const path of runtimeImported) {
  if (!matchesWar(path)) {
    fail(`web_accessible_resources dekt ${path} niet — de dynamische import faalt in het content script`);
  }
}

// --------------------------------------------------------------- HTML ------

for (const file of sourceFiles.filter((f) => f.endsWith('.html'))) {
  const source = readFileSync(file, 'utf8');
  const here = dirname(file);
  for (const [, ref] of source.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(https?:|data:|#)/.test(ref)) continue;
    if (!existsSync(resolve(here, ref))) {
      fail(`${relative(ROOT, file)}: verwijzing bestaat niet → ${ref}`);
    }
  }

  // Every element the page's script looks up by id must be in the markup.
  const scriptRef = source.match(/<script[^>]+src="([^"]+)"/)?.[1];
  if (!scriptRef) continue;
  const scriptPath = resolve(here, scriptRef);
  if (!existsSync(scriptPath)) continue;
  const script = readFileSync(scriptPath, 'utf8');
  const ids = new Set([...source.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id));
  for (const [, id] of script.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!ids.has(id)) fail(`${relative(ROOT, scriptPath)}: getElementById("${id}") bestaat niet in ${relative(ROOT, file)}`);
  }
  for (const [, id] of script.matchAll(/\bel\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!ids.has(id)) fail(`${relative(ROOT, scriptPath)}: el("${id}") bestaat niet in ${relative(ROOT, file)}`);
  }
  // Form fields addressed by name must exist too.
  const names = new Set([...source.matchAll(/\bname="([^"]+)"/g)].map(([, name]) => name));
  for (const [, name] of script.matchAll(/elements\.namedItem\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!names.has(name)) fail(`${relative(ROOT, scriptPath)}: veld "${name}" bestaat niet in ${relative(ROOT, file)}`);
  }
}

// --------------------------------------------------------------- report ----

if (problems.length) {
  console.error(`\n${problems.length} probleem(en) gevonden:\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log('✓ Extensie is consistent: alle paden, imports en element-id’s kloppen.');
