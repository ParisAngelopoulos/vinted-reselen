/**
 * Zips the extension for distribution or for the Chrome Web Store, excluding
 * everything that is only needed for development.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const output = join(ROOT, `vinted-relister-${version}.zip`);

rmSync(output, { force: true });
execFileSync(
  'zip',
  ['-r', '-q', output, 'manifest.json', 'src', 'icons', '-x', '*.DS_Store'],
  { cwd: ROOT, stdio: 'inherit' },
);
console.log(`Klaar: ${output}`);
