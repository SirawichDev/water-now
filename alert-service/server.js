import { createServer } from 'node:http';
import { fetchWaterHistory } from './sources/thaiwater.js';

const HISTORY_TTL_MS = 10 * 60_000;
const MAX_BODY_BYTES = 1024;
const MAX_UPDATE_BYTES = 64 * 1024; // a Telegram update

/**
 * The service's HTTP API as one `(req, res)` handler: JSON snapshots for the
 * map, report submission, the poll trigger, the Telegram webhook, and (when a
 * process stays up) an SSE stream that says when to refetch.
 *
 * @param {object} app  from app.js
 * @param {object} [opts]
 * @param {boolean} [opts.serverless]  Vercel: no SSE, client IP from Vercel's
 *   header, CDN caching on the read routes
 * @param {(p: Promise<unknown>) => void} [opts.waitUntil]  keep work running
 *   after the response (Vercel's waitUntil); plain fire-and-forget otherwise
 */
export function createHandler(
  app,
  {
    serverless = false,
    waitUntil = (p) => void p.catch(() => {}),
    userAgent = 'bkk-watch',
    fetchHistory = fetchWaterHistory,
    cronSecret = '',
    telegramSecret = '',
  } = {},
) {
  const { engine, news, nearby, reports, history: timeline, hail } = app;
  const clients = new Set();
  const history = new Map(); // station id → { at, data }
  if (!serverless) {
    engine.events.on('update', (kind) => {
      const frame = `event: update\ndata: ${JSON.stringify({ kind, at: Date.now() })}\n\n`;
      for (const res of clients) res.write(frame);
    });
    // Comment frames keep idle proxies from closing the stream.
    setInterval(() => {
      for (const res of clients) res.write(': ping\n\n');
    }, 25_000).unref();
  }

  /** Read routes: no-store locally; briefly cached by Vercel's CDN. */
  const json = (res, status, body, cdnSeconds = 0) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control':
        serverless && cdnSeconds && status === 200
          ? `public, s-maxage=${cdnSeconds}, stale-while-revalidate=${cdnSeconds * 2}`
          : 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  /** lat/lon query parameters inside Thailand, or null. */
  const point = (url) => {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const ok =
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= 5.5 &&
      lat <= 20.6 &&
      lon >= 97.3 &&
      lon <= 105.7;
    return ok ? { lat, lon } : null;
  };

  /**
   * The sender's address. On Vercel the platform sets x-real-ip; locally the
   * dev-server proxy is the only trusted forwarder (loopback).
   */
  const senderIp = (req) => {
    if (serverless)
      return String(
        req.headers['x-real-ip'] ||
          String(req.headers['x-forwarded-for'] || '').split(',')[0],
      ).trim();
    const direct = req.socket.remoteAddress || '';
    const loopback = /^(::1|::ffff:127\.|127\.)/.test(direct);
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    return loopback && forwarded ? forwarded : direct;
  };

  function readJson(req, limit = MAX_BODY_BYTES) {
    // Vercel may have parsed the body already.
    if (req.body !== undefined)
      return Promise.resolve(
        typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body,
      );
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /** The poll trigger takes the secret as a bearer token or ?key=. */
  const cronAllowed = (req, url) =>
    Boolean(cronSecret) &&
    (req.headers.authorization === `Bearer ${cronSecret}` ||
      url.searchParams.get('key') === cronSecret);

  /** When data is older than this, a visit starts a refresh (serverless). */
  const STALE_VISIT_MS = 10 * 60_000;

  async function route(req, res, url) {
    const path = url.pathname;

    if (req.method === 'POST' && path === '/api/bkk/reports' && reports) {
      const body = await readJson(req);
      const result = await reports.add(body, senderIp(req));
      if (!result.ok) return json(res, result.status, { error: result.error });
      engine.events.emit('update', 'reports');
      // A hail report changes the zones; recompute without waiting.
      if (result.reports.some((r) => r.kind === 'hail'))
        waitUntil(hail.refresh({ fresh: true }));
      return json(res, 201, { reports: result.reports });
    }
    if (req.method === 'POST' && path === '/api/bkk/telegram') {
      if (
        !app.telegram ||
        !telegramSecret ||
        req.headers['x-telegram-bot-api-secret-token'] !== telegramSecret
      )
        return json(res, 403, { error: 'forbidden' });
      await app.telegram.handleUpdate(await readJson(req, MAX_UPDATE_BYTES));
      return json(res, 200, { ok: true });
    }
    if (path === '/api/bkk/cron') {
      if (!cronAllowed(req, url))
        return json(res, 401, { error: 'unauthorized' });
      // The caller (an external scheduler) may give up after ~30 s; the polls
      // carry on in the background up to the function's time limit.
      const run = app.runDue({ force: url.searchParams.get('force') });
      if (url.searchParams.get('wait') === '1')
        return json(res, 200, await run);
      waitUntil(run);
      return json(res, 202, { started: true });
    }
    if (req.method !== 'GET')
      return json(res, 405, { error: 'Method not allowed' });

    switch (path) {
      case '/api/bkk/water':
        return json(res, 200, await engine.snapshot('water'), 30);
      case '/api/bkk/water/history': {
        const id = url.searchParams.get('id') || '';
        if (!/^\d{1,12}$/.test(id)) return json(res, 400, { error: 'bad id' });
        const hit = history.get(id);
        if (hit && Date.now() - hit.at < HISTORY_TTL_MS)
          return json(res, 200, hit.data, 300);
        try {
          const data = await fetchHistory(id, { userAgent });
          if (history.size > 400) history.clear();
          history.set(id, { at: Date.now(), data });
          return json(res, 200, data, 300);
        } catch (e) {
          return json(res, 502, { error: e.message, points: [] });
        }
      }
      case '/api/bkk/water/timeline':
        return json(
          res,
          200,
          (await timeline?.timeline()) || {
            hours: [],
            series: {},
            over: [],
            near: [],
          },
          60,
        );
      case '/api/bkk/river': {
        const at = point(url);
        if (!at || !nearby) return json(res, 400, { error: 'bad lat/lon' });
        try {
          const data = await nearby.getRiver(at.lat, at.lon, {
            cachedOnly: url.searchParams.get('cached') === '1',
          });
          return json(res, 200, data, data.rivers ? 3600 : 0);
        } catch (e) {
          return json(res, 502, { error: e.message, rivers: null });
        }
      }
      case '/api/bkk/places':
      case '/api/bkk/food':
      case '/api/bkk/rain': {
        const at = point(url);
        if (!at || !nearby) return json(res, 400, { error: 'bad lat/lon' });
        const kind = path.split('/').pop();
        const get = {
          places: nearby.getPlaces,
          food: nearby.getFood,
          rain: nearby.getRain,
        }[kind];
        try {
          return json(
            res,
            200,
            await get(at.lat, at.lon),
            kind === 'rain' ? 900 : 3600,
          );
        } catch (e) {
          return json(res, 502, { error: e.message });
        }
      }
      case '/api/bkk/reports': {
        const [list, spots] = reports
          ? await Promise.all([reports.list(), reports.spots()])
          : [[], []];
        return json(res, 200, {
          reports: list,
          levels: reports?.levels || [],
          spots,
          choices: reports?.choices || {},
        });
      }
      case '/api/bkk/outages':
        return json(res, 200, await engine.snapshot('outages'), 60);
      case '/api/bkk/news':
        return json(
          res,
          200,
          news
            ? await news.current()
            : { updatedAt: null, error: 'news disabled', items: [] },
          60,
        );
      case '/api/bkk/hail':
        return json(res, 200, await hail.current(), 30);
      case '/api/bkk/version': {
        // What browsers poll instead of the SSE stream on Vercel.
        const times = await app.versions();
        if (serverless && Date.now() - (times.water || 0) > STALE_VISIT_MS)
          waitUntil(app.runDue());
        return json(res, 200, times, 10);
      }
      case '/api/bkk/health': {
        const water = await engine.snapshot('water');
        const outages = await engine.snapshot('outages');
        return json(res, 200, {
          ok: true,
          store: app.store.kind,
          water: { updatedAt: water.updatedAt, error: water.error },
          outages: { updatedAt: outages.updatedAt, error: outages.error },
          streamClients: clients.size,
        });
      }
      case '/api/bkk/stream':
        // Nothing stays up between requests on Vercel: 204 tells EventSource
        // to stop retrying, and the page polls /api/bkk/version instead.
        if (serverless) {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write('retry: 5000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      default:
        return json(res, 404, { error: 'Unknown route' });
    }
  }

  return (req, res) => {
    const url = new URL(req.url, 'http://x');
    route(req, res, url).catch((e) => {
      console.warn(`[http] ${url.pathname}: ${e.message}`);
      if (res.headersSent) return res.end();
      json(res, /body too large|invalid JSON/.test(e.message) ? 400 : 500, {
        error: e.message,
      });
    });
  };
}

/** The local service: the same handler behind a plain HTTP server. */
export function createHttpServer(app, opts) {
  return createServer(createHandler(app, opts));
}
