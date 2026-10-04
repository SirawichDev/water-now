// Vercel: every /api/* request lands in this one function (vercel.json
// rewrites /api/:path* here). Flood-service routes (/api/bkk/*) go to the
// alert service's handler; everything else runs through the same provider
// middleware the Vite dev server installs, so advanced mode keeps its proxies.
import { waitUntil } from '@vercel/functions';
import { config } from '../alert-service/config.js';
import { createApp } from '../alert-service/app.js';
import { createHandler } from '../alert-service/server.js';
import { localProviderPlugins } from '../server/providers/local.js';
import { apiNotFoundPlugin } from '../server/standalone/api-not-found.js';
import { createMiddlewareStack } from '../server/standalone/middleware-stack.js';

// Only /tmp is writable on Vercel; providers keep their caches under the
// working directory (.gev-cache), so that is where they go.
try {
  process.chdir('/tmp');
} catch {
  /* not on Vercel */
}

// Built once per instance and reused by later requests on it.
let bkk = null;
const bkkHandler = () =>
  (bkk ??= createApp(config).then((app) =>
    createHandler(app, {
      serverless: true,
      waitUntil,
      userAgent: config.userAgent,
      cronSecret: config.cronSecret,
      telegramSecret: config.telegramWebhookSecret,
    }),
  )).catch((e) => {
    bkk = null; // let the next request try again
    throw e;
  });

// Provider Settings writes API keys into .env: a local-only tool, never part
// of a public deployment.
const LOCAL_ONLY = new Set(['gev-key-setup']);

let providers = null;
const providerStack = () =>
  (providers ??= createMiddlewareStack([
    ...localProviderPlugins().filter((p) => !LOCAL_ONLY.has(p.name)),
    apiNotFoundPlugin(),
  ]));

/** The path the browser asked for: the rewrite passes it as ?__p=. */
function restoreUrl(req) {
  const url = new URL(req.url, 'http://x');
  const path = url.searchParams.get('__p');
  if (path == null) return;
  url.searchParams.delete('__p');
  const query = url.searchParams.toString();
  req.url = `/api/${path}${query ? `?${query}` : ''}`;
}

export default async function handler(req, res) {
  restoreUrl(req);
  try {
    if (req.url === '/api/bkk' || req.url.startsWith('/api/bkk/'))
      return (await bkkHandler())(req, res);
    return providerStack()(req, res);
  } catch (e) {
    console.error(`[api] ${req.url}: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error' }));
    }
  }
}
