/**
 * A stand-in for the Vinted web API, just complete enough to drive the
 * extension end to end. Used by the e2e test together with Chromium's
 * --host-resolver-rules so the extension really believes it is on vinted.nl.
 */

import { createServer } from 'node:http';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export function createMockVinted({ items } = {}) {
  const calls = [];
  const state = {
    items: new Map((items ?? defaultItems()).map((item) => [String(item.id), item])),
    photoSeq: 500,
    createdSeq: 900,
    created: [],
    deleted: [],
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://www.vinted.nl');
    const path = url.pathname;
    calls.push({ method: req.method, path, headers: req.headers });

    const json = (body, status = 200) => {
      // Rails negotiates on Accept: a caller that does not ask for JSON is
      // served the HTML page instead of API data. Vinted behaves this way, and
      // it is what made a working endpoint look like a blocked one.
      const accept = req.headers.accept || '';
      if (path.startsWith('/api/') && !accept.includes('application/json')) {
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head><title>Vinted</title></head><body>Access denied</body></html>');
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // The page the content script is injected into.
    if (path === '/' || path === '/member/1' || path === '/member/items') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // The real site sets this; the extension must echo it back as X-Anon-Id.
        'set-cookie': 'anon_id=test-anon-id; Path=/',
      });
      res.end(
        '<!doctype html><html><head><meta name="csrf-token" content="test-csrf-token"></head>' +
          '<body><h1>Mock Vinted</h1><script>' +
          // Stand-in for the site's own front-end traffic, which is what the
          // recorder is supposed to observe.
          "fetch('/api/v2/feed?page=1&per_page=20');" +
          "var x=new XMLHttpRequest();x.open('POST','/api/v2/tracking');x.send();" +
          '</script></body></html>',
      );
      return;
    }

    if (path.startsWith('/photo/')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(ONE_PIXEL_PNG);
      return;
    }

    if (path === '/api/v2/feed' || path === '/api/v2/tracking') {
      return json({ ok: true });
    }

    // Retired on the real site: no longer called by the front-end, and it
    // answers with a protection page rather than JSON.
    if (path === '/api/v2/users/current' || path === '/api/v2/user') {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><head><title>Vinted</title><style>*{box-sizing:border-box}</style></head><body>Access denied</body></html>');
      return;
    }

    if (path === '/api/v2/wardrobe/1/items') {
      return json({
        items: [...state.items.values()],
        pagination: { current_page: 1, total_pages: 1, total_entries: state.items.size },
      });
    }

    const uploadDetail = path.match(/^\/api\/v2\/item_upload\/items\/(\d+)$/);
    if (uploadDetail && req.method === 'GET') {
      const item = state.items.get(uploadDetail[1]);
      if (!item) return json({ message: 'niet gevonden' }, 404);
      return json({ item });
    }

    if (path === '/api/v2/photos' && req.method === 'POST') {
      await drain(req);
      state.photoSeq += 1;
      return json({ id: state.photoSeq, orientation: 0 });
    }

    if (path === '/api/v2/item_upload/items' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      state.createdSeq += 1;
      state.created.push(body);
      return json({ item: { id: state.createdSeq, title: body.item.title } });
    }

    const itemPath = path.match(/^\/api\/v2\/items\/(\d+)$/);
    if (itemPath && req.method === 'DELETE') {
      state.deleted.push(itemPath[1]);
      state.items.delete(itemPath[1]);
      res.writeHead(204);
      res.end();
      return;
    }

    json({ message: `geen route voor ${req.method} ${path}` }, 404);
  });

  return {
    server,
    state,
    calls,
    listen: (port) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function defaultItems() {
  return [
    {
      id: 101,
      title: 'Nike hoodie',
      description: 'Nauwelijks gedragen, maat M.',
      price: { amount: '25.00', currency_code: 'EUR' },
      catalog_id: 221,
      brand_id: 53,
      brand: 'Nike',
      size_id: 207,
      status_id: 2,
      package_size_id: 2,
      color_ids: [1],
      created_at_ts: '2025-01-01T10:00:00Z',
      photos: [
        { id: 1, full_size_url: 'http://www.vinted.nl/photo/1.png' },
        { id: 2, full_size_url: 'http://www.vinted.nl/photo/2.png' },
      ],
    },
    {
      id: 102,
      title: 'Levi 501',
      description: 'Klassieke jeans.',
      price: { amount: '40.00', currency_code: 'EUR' },
      catalog_id: 257,
      brand_id: 88,
      brand: 'Levi',
      size_id: 210,
      status_id: 3,
      package_size_id: 2,
      color_ids: [3],
      created_at_ts: '2025-02-01T10:00:00Z',
      photos: [{ id: 3, full_size_url: 'http://www.vinted.nl/photo/3.png' }],
    },
    {
      id: 103,
      title: 'Verkochte trui',
      description: 'Weg.',
      price: { amount: '15.00', currency_code: 'EUR' },
      catalog_id: 221,
      is_closed: true,
      photos: [{ id: 4, full_size_url: 'http://www.vinted.nl/photo/4.png' }],
    },
  ];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function drain(req) {
  return new Promise((resolve) => {
    req.on('data', () => {});
    req.on('end', resolve);
  });
}
