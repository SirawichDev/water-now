import { createServer } from 'node:http';
import { fetchWaterHistory } from './sources/thaiwater.js';

const HISTORY_TTL_MS = 10 * 60_000;
const MAX_BODY_BYTES = 1024;

/** JSON snapshots for the map plus an SSE stream that says when to refetch. */
export function createHttpServer({
  engine,
  news = null,
  nearby = null,
  reports = null,
  timeline = null,
  userAgent = 'bkk-watch',
  fetchHistory = fetchWaterHistory,
}) {
  const clients = new Set();
  const history = new Map(); // station id → { at, data }
  engine.events.on('update', (kind) => {
    const frame = `event: update\ndata: ${JSON.stringify({ kind, at: Date.now() })}\n\n`;
    for (const res of clients) res.write(frame);
  });
  // Comment frames keep idle proxies from closing the stream.
  setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25_000).unref();

  const json = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
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

  /** The dev-server proxy is the only trusted forwarder (loopback). */
  const senderIp = (req) => {
    const direct = req.socket.remoteAddress || '';
    const loopback = /^(::1|::ffff:127\.|127\.)/.test(direct);
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    return loopback && forwarded ? forwarded : direct;
  };

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
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

  return createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    if (req.method === 'POST' && path === '/api/bkk/reports' && reports) {
      readJson(req)
        .then((body) => {
          const result = reports.add(body, senderIp(req));
          if (!result.ok)
            return json(res, result.status, { error: result.error });
          engine.events.emit('update', 'reports');
          return json(res, 201, { reports: result.reports });
        })
        .catch((e) => json(res, 400, { error: e.message }));
      return;
    }
    if (req.method !== 'GET')
      return json(res, 405, { error: 'Method not allowed' });

    switch (path) {
      case '/api/bkk/water':
        return json(res, 200, engine.state.water);
      case '/api/bkk/water/history': {
        const id = url.searchParams.get('id') || '';
        if (!/^\d{1,12}$/.test(id)) return json(res, 400, { error: 'bad id' });
        const hit = history.get(id);
        if (hit && Date.now() - hit.at < HISTORY_TTL_MS)
          return json(res, 200, hit.data);
        fetchHistory(id, { userAgent })
          .then((data) => {
            if (history.size > 400) history.clear();
            history.set(id, { at: Date.now(), data });
            json(res, 200, data);
          })
          .catch((e) => json(res, 502, { error: e.message, points: [] }));
        return;
      }
      case '/api/bkk/water/timeline':
        return json(
          res,
          200,
          timeline?.timeline() || { hours: [], series: {}, over: [], near: [] },
        );
      case '/api/bkk/river': {
        const at = point(url);
        if (!at || !nearby) return json(res, 400, { error: 'bad lat/lon' });
        nearby
          .getRiver(at.lat, at.lon, {
            cachedOnly: url.searchParams.get('cached') === '1',
          })
          .then((data) => json(res, 200, data))
          .catch((e) => json(res, 502, { error: e.message, rivers: null }));
        return;
      }
      case '/api/bkk/places':
      case '/api/bkk/food':
      case '/api/bkk/rain': {
        const at = point(url);
        if (!at || !nearby) return json(res, 400, { error: 'bad lat/lon' });
        const get = {
          places: nearby.getPlaces,
          food: nearby.getFood,
          rain: nearby.getRain,
        }[path.split('/').pop()];
        get(at.lat, at.lon)
          .then((data) => json(res, 200, data))
          .catch((e) => json(res, 502, { error: e.message }));
        return;
      }
      case '/api/bkk/reports':
        return json(res, 200, {
          reports: reports?.list() || [],
          levels: reports?.levels || [],
          spots: reports?.spots() || [],
          choices: reports?.choices || {},
        });
      case '/api/bkk/outages':
        return json(res, 200, engine.state.outages);
      case '/api/bkk/news':
        return json(
          res,
          200,
          news?.state || { updatedAt: null, error: 'news disabled', items: [] },
        );
      case '/api/bkk/health':
        return json(res, 200, {
          ok: true,
          water: {
            updatedAt: engine.state.water.updatedAt,
            error: engine.state.water.error,
          },
          outages: {
            updatedAt: engine.state.outages.updatedAt,
            error: engine.state.outages.error,
          },
          streamClients: clients.size,
        });
      case '/api/bkk/stream':
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
  });
}
