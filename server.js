/**
 * BlueWheel BI backend: one small Node HTTP server that runs the endpoint handlers in api/ (each is
 * `handler(req, res)` and does its own sign-in and permission checks through api/_lib/guard.js).
 *
 *  - Google Cloud Run: started with `npm start`; Cloud Run sets PORT and K_SERVICE. Google credentials
 *    come from the service account the service runs as (no key file or private key in settings).
 *  - This computer: `npm run dev` (port 3000) reads .env; master-app's Vite dev server
 *    forwards /api here.
 *
 * The browser never calls this server directly: Netlify forwards the site's /api/* to it, so the
 * Origin / Referer the guard checks is the dashboard site's own address (ALLOWED_ORIGIN).
 */
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Change requests are small JSON; 1 MB is far above any real one and limits memory per request.
const MAX_BODY = 1024 * 1024;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return /json/i.test(req.headers['content-type'] || '') && raw ? JSON.parse(raw) : raw;
  } catch {
    return raw;
  }
}

/**
 * The request listener. `routes` maps "a/b" to the handler for /api/a/b. `env` decides whether this
 * is a deployed server (Cloud Run sets K_SERVICE), which turns off the localhost allowance in the guard.
 */
export function createApp(routes, env = process.env) {
  const deployed = Boolean(env.K_SERVICE);
  return async function app(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // A malformed request line (e.g. "GET http://[/") must be a 400, never an unhandled error that stops the server.
    let url;
    try {
      url = new URL(req.url, 'http://backend');
    } catch {
      return sendJson(res, 400, { error: 'Bad request.' });
    }

    if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

    const route = url.pathname.startsWith('/api/') ? url.pathname.slice(5).replace(/\/+$/, '') : null;
    const handler = route && Object.hasOwn(routes, route) ? routes[route] : null;
    if (!handler) return sendJson(res, 404, { error: 'Not found' });

    // The (req, res) helpers the handlers use: req.query, res.status(), res.json().
    req.query = Object.create(null); // no inherited keys: ?__proto__=x cannot change it
    for (const key of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(key);
      req.query[key] = all.length > 1 ? all : all[0];
    }
    req.platform = { origins: [], deployed };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };

    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // Refuse an oversized body before reading any of it.
        if (Number(req.headers['content-length'] || 0) > MAX_BODY) return sendJson(res, 413, { error: 'Request too large.' });
        req.body = await readBody(req);
      }
      await handler(req, res);
      if (!res.writableEnded) res.end();
    } catch (err) {
      if (err?.status === 413) return sendJson(res, 413, { error: 'Request too large.' });
      console.error('Handler crashed:', err);
      return sendJson(res, 500, { error: 'Server error.' });
    }
  };
}

// Started directly (npm start / npm run dev), not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  // Local settings only off Cloud Run; Cloud Run gets its settings from the service configuration.
  if (!process.env.K_SERVICE) {
    for (const file of ['.env']) {
      const full = path.join(import.meta.dirname, file);
      if (existsSync(full)) process.loadEnvFile(full);
    }
  }
  const { ROUTES } = await import('./routes.js');
  const port = Number(process.env.PORT || 3000);
  http.createServer(createApp(ROUTES)).listen(port, () => console.log(`BlueWheel BI backend on port ${port}${process.env.K_SERVICE ? '' : ' (local, reads .env)'}`));
}
