/**
 * Working out which Vinted account is signed in.
 *
 * The obvious route — GET /api/v2/users/current — is gone: the site no longer
 * calls it and it answers with a protection page. But the id is not a secret
 * that needs an API at all. It is in the URL of your own profile page, and in
 * the wardrobe call the site makes to list your items.
 *
 * Pure string handling, so it can be unit tested without a browser.
 */

/** Vinted profile URLs look like /member/3152705349 or /member/3152705349-name. */
export function parseMemberIdFromPath(pathname) {
  const match = /^\/member\/(\d+)(?:[-/?#]|$)/.exec(pathname || '');
  return match ? match[1] : null;
}

/** Pull the account id out of a recorded wardrobe call. */
export function parseWardrobeIdFromApiPath(path) {
  const match = /\/api\/v\d+\/wardrobe\/(\d+)\/items/.exec(path || '');
  return match ? match[1] : null;
}

/**
 * Ids seen in recorded endpoints, most-seen first.
 *
 * Browsing someone else's closet records their id too, so this is a
 * suggestion, not proof — hence the ordering by how often each was seen, and
 * the manual override in the settings.
 */
export function wardrobeIdsFromObserved(observed = []) {
  const counts = new Map();
  for (const row of observed) {
    const id = parseWardrobeIdFromApiPath(row.entry);
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + (row.count || 1));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Decide which id to use, and say where it came from so the UI can explain
 * itself when it picks wrong.
 *
 * `apiUserId` comes last because it costs a request the other sources do not,
 * but it must be in the chain: without it the extension can report "could not
 * determine your id" while the API right next to it knows exactly who you are.
 *
 * @param {{override?: string, remembered?: string, pathname?: string, observed?: Array, apiUserId?: string|number}} sources
 * @returns {{id: string|null, source: string}}
 */
export function resolveUserId({ override, remembered, pathname, observed, apiUserId } = {}) {
  const cleanOverride = String(override || '').trim();
  if (/^\d+$/.test(cleanOverride)) {
    return { id: cleanOverride, source: 'handmatig ingesteld' };
  }

  const fromPath = parseMemberIdFromPath(pathname);
  if (fromPath) return { id: fromPath, source: 'de profielpagina die open staat' };

  if (remembered && /^\d+$/.test(String(remembered))) {
    return { id: String(remembered), source: 'eerder herkend profiel' };
  }

  const [mostSeen] = wardrobeIdsFromObserved(observed);
  if (mostSeen) return { id: mostSeen, source: 'waargenomen verzoek van de site' };

  if (apiUserId !== undefined && apiUserId !== null && /^\d+$/.test(String(apiUserId))) {
    return { id: String(apiUserId), source: 'opgevraagd bij Vinted' };
  }

  return { id: null, source: 'onbekend' };
}
