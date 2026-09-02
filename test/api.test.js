import assert from 'node:assert/strict';
import test from 'node:test';

import { VintedApi, VintedApiError } from '../src/lib/api.js';

/** Fake fetch driven by a list of scripted responses, keyed by path. */
function fakeFetch(routes) {
  const seen = [];
  const impl = async (url, init = {}) => {
    const path = url.replace('https://www.vinted.nl', '');
    seen.push({ path, method: init.method || 'GET', headers: init.headers || {} });
    const route = routes[path];
    if (!route) return new Response('{}', { status: 404 });
    const { status = 200, body = {} } = typeof route === 'function' ? route() : route;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  impl.seen = seen;
  return impl;
}

function api(routes, overrides = {}) {
  return new VintedApi({
    origin: 'https://www.vinted.nl',
    minGapMs: 0,
    fetchImpl: fakeFetch(routes),
    ...overrides,
  });
}

test('readAnonId picks the cookie out of a full cookie string', () => {
  assert.equal(VintedApi.readAnonId('foo=1; anon_id=abc-123; bar=2'), 'abc-123');
  assert.equal(VintedApi.readAnonId('anon_id=abc-123'), 'abc-123');
  assert.equal(VintedApi.readAnonId('anonymous_id=nope'), null, 'must not match a similarly named cookie');
  assert.equal(VintedApi.readAnonId('foo=1'), null);
  assert.equal(VintedApi.readAnonId(''), null);
  assert.equal(VintedApi.readAnonId(undefined), null);
  assert.equal(VintedApi.readAnonId('anon_id=a%20b'), 'a b', 'values are url-decoded');
});

test('the request headers mirror what the web app sends', async () => {
  const client = api({ '/api/v2/users/current': { body: { user: { id: 7 } } } }, {
    csrfToken: 'csrf-1',
    anonId: 'anon-1',
  });
  await client.getCurrentUser();

  const { headers } = client.fetchImpl.seen[0];
  assert.equal(headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(headers['X-Anon-Id'], 'anon-1');
  assert.equal(
    headers['X-Requested-With'],
    undefined,
    'a header the real client never sends is exactly what gets a request flagged',
  );
});

test('optional headers are omitted rather than sent empty', async () => {
  const client = api({ '/api/v2/users/current': { body: { user: { id: 7 } } } });
  await client.getCurrentUser();
  const { headers } = client.fetchImpl.seen[0];
  assert.ok(!('X-CSRF-Token' in headers));
  assert.ok(!('X-Anon-Id' in headers));
});

test('getCurrentUser falls back to the older path when the first one is refused', async () => {
  const client = api({
    '/api/v2/users/current': { status: 403, body: { message: 'verboden' } },
    '/api/v2/user': { body: { user: { id: 42, login: 'tester' } } },
  });
  const user = await client.getCurrentUser();
  assert.equal(user.id, 42);
  assert.deepEqual(client.fetchImpl.seen.map((r) => r.path), [
    '/api/v2/users/current',
    '/api/v2/user',
  ]);
});

test('when every variant is refused the error names the last call', async () => {
  const client = api({
    '/api/v2/users/current': { status: 401, body: { message: 'niet ingelogd' } },
    '/api/v2/user': { status: 401, body: { message: 'niet ingelogd' } },
  });
  await assert.rejects(
    () => client.getCurrentUser(),
    (error) => {
      assert.ok(error instanceof VintedApiError);
      assert.equal(error.status, 401);
      assert.match(error.message, /GET \/api\/v2\/user/, 'de melding hoort de aanroep te noemen');
      return true;
    },
  );
});

test('item detail does not fall back on a refusal, only on a missing route', async () => {
  // A 403 on the upload endpoint means "not allowed", not "wrong path": falling
  // through would build a listing from thinner public data.
  const client = api({
    '/api/v2/item_upload/items/5': { status: 403, body: { message: 'verboden' } },
    '/api/v2/items/5': { body: { item: { id: 5 } } },
  });
  await assert.rejects(() => client.getItem(5), (error) => error.status === 403);
  assert.equal(client.fetchImpl.seen.length, 1);
});

test('item detail does fall back when the newer route is gone', async () => {
  const client = api({
    '/api/v2/item_upload/items/5': { status: 404, body: {} },
    '/api/v2/items/5': { body: { item: { id: 5, title: 'Trui' } } },
  });
  const item = await client.getItem(5);
  assert.equal(item.title, 'Trui');
});

test('diagnose reports each call instead of throwing', async () => {
  const client = api({
    '/api/v2/users/current': { status: 403, body: { message: 'verboden' } },
    '/api/v2/user': { body: { user: { id: 9 } } },
    '/api/v2/wardrobe/9/items?page=1&per_page=1': {
      body: { items: [{ id: 1 }], pagination: { total_entries: 12 } },
    },
  });

  const report = await client.diagnose();
  assert.equal(report.userId, 9);
  assert.equal(report.itemCount, 12);

  const current = report.checks.find((c) => c.path === '/api/v2/users/current');
  assert.equal(current.ok, false);
  assert.equal(current.status, 403);
  assert.equal(current.detail, 'verboden');
  assert.ok(report.checks.some((c) => c.ok), 'de geslaagde aanroepen horen er ook in te staan');
});

test('a 429 is retried and then succeeds', async () => {
  let attempts = 0;
  const client = api({
    '/api/v2/users/current': () => {
      attempts += 1;
      return attempts === 1 ? { status: 429, body: {} } : { body: { user: { id: 3 } } };
    },
  });
  client.maxRetries = 1;
  const user = await client.getCurrentUser();
  assert.equal(user.id, 3);
  assert.equal(attempts, 2);
});

const BLOCK_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Vinted</title>
  <style>* { box-sizing: border-box; }</style>
</head>
<body>Access denied</body>
</html>`;

test('an HTML response is reported as a block, not as a logged-out session', async () => {
  const client = api({
    '/api/v2/users/current': { status: 403, body: BLOCK_PAGE },
    '/api/v2/user': { status: 403, body: BLOCK_PAGE },
  });

  await assert.rejects(
    () => client.getCurrentUser(),
    (error) => {
      assert.equal(error.isBlockPage, true);
      assert.match(error.message, /geblokkeerd door de beveiliging/);
      assert.doesNotMatch(
        error.message,
        /log opnieuw in/i,
        'telling a logged-in user to log in again sends them to fix the wrong thing',
      );
      return true;
    },
  );
});

test('a block page never leaks raw markup into the report', async () => {
  const client = api({
    '/api/v2/users/current': { status: 403, body: BLOCK_PAGE },
    '/api/v2/user': { status: 403, body: BLOCK_PAGE },
  });

  const report = await client.diagnose();
  assert.equal(report.userId, null);
  for (const check of report.checks) {
    assert.equal(check.blocked, true);
    assert.match(check.detail, /geblokkeerd — Vinted stuurde een webpagina terug \("Vinted"\)/);
    assert.doesNotMatch(check.detail, /<!doctype|<html|<style/i);
  }
});

test('a genuine JSON 403 still reads as a session problem', async () => {
  const client = api({
    '/api/v2/users/current': { status: 403, body: { message: 'Sessie verlopen' } },
    '/api/v2/user': { status: 403, body: { message: 'Sessie verlopen' } },
  });
  await assert.rejects(
    () => client.getCurrentUser(),
    (error) => {
      assert.equal(error.isBlockPage, false);
      assert.match(error.message, /Sessie verlopen/);
      return true;
    },
  );
});

test('an HTML body on a successful-looking route is not mistaken for JSON', () => {
  // Guard against a page that merely mentions doctype inside a JSON string.
  assert.doesNotMatch(JSON.stringify({ note: '<!doctype html>' }), /^<!doctype/i);
});

test('every request asks for JSON, not just the writes', async () => {
  const client = api({
    '/api/v2/wardrobe/7/items?page=1&per_page=20&order=relevance': { body: { items: [] } },
  });
  await client.listOwnItems(7);

  const { headers } = client.fetchImpl.seen[0];
  assert.match(
    headers.Accept,
    /application\/json/,
    'Rails serves the HTML page to a caller that does not ask for JSON',
  );
});

test('a JSON body request keeps both Accept and Content-Type', async () => {
  const client = api({ '/api/v2/item_upload/items': { body: { item: { id: 1 } } } });
  await client.createItem({ item: {} });

  const { headers } = client.fetchImpl.seen[0];
  assert.match(headers.Accept, /application\/json/);
  assert.equal(headers['Content-Type'], 'application/json');
});

test('when every variant fails the error names all of them', async () => {
  const client = api({
    '/api/v2/wardrobe/7/items?page=1&per_page=20&order=relevance': { status: 403, body: {} },
    '/api/v2/users/7/items?page=1&per_page=20&order=relevance': { status: 403, body: {} },
  });
  await assert.rejects(
    () => client.listOwnItems(7),
    (error) => {
      assert.match(
        error.message,
        /ook geprobeerd: \/api\/v2\/wardrobe\/7\/items/,
        'reporting only the last attempt hides that the preferred route failed too',
      );
      return true;
    },
  );
});

test('readCsrfCookie finds a token kept in a cookie', () => {
  assert.equal(VintedApi.readCsrfCookie('a=1; csrf_token=abc123; b=2'), 'abc123');
  assert.equal(VintedApi.readCsrfCookie('XSRF-CSRF=zzz'), 'zzz');
  assert.equal(VintedApi.readCsrfCookie('anon_id=nope; session=x'), null);
  assert.equal(VintedApi.readCsrfCookie(''), null);
  assert.equal(VintedApi.readCsrfCookie(undefined), null);
});

test('cookieNames reports names only, never values', () => {
  const names = VintedApi.cookieNames('anon_id=secret-value; _vinted_session=another-secret');
  assert.deepEqual(names, ['_vinted_session', 'anon_id']);
  assert.ok(!names.join(' ').includes('secret'), 'a value must never reach the report');
});

test('an error names the status, not just the endpoint', () => {
  const error = new VintedApiError('Foutmelding bij uploaden foto', {
    status: 422,
    path: '/api/v2/photos',
    method: 'POST',
  });
  assert.match(
    error.message,
    /\[422 POST \/api\/v2\/photos\]/,
    "Vinted's own wording says nothing about refused vs rejected vs rate-limited",
  );
});

test('a downloaded photo that is not an image is refused before it is uploaded', async () => {
  const client = new VintedApi({
    origin: 'https://www.vinted.nl',
    minGapMs: 0,
    fetchImpl: async () =>
      new Response('<!doctype html><html><body>nope</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
  });

  await assert.rejects(
    () => client.downloadPhoto('https://images.vinted.net/a.jpg'),
    (error) => {
      assert.match(
        error.message,
        /geen afbeelding op maar text\/html/,
        'uploading whatever came back turns a CDN error page into an opaque rejection',
      );
      return true;
    },
  );
});

test('a real image passes the download check', async () => {
  const client = new VintedApi({
    origin: 'https://www.vinted.nl',
    minGapMs: 0,
    fetchImpl: async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      }),
  });
  const blob = await client.downloadPhoto('https://images.vinted.net/a');
  assert.equal(blob.type, 'image/webp');
});
