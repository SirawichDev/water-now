import { request } from 'node:http';

const TARGET_HOST = process.env.BKK_ALERT_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.BKK_ALERT_PORT) || 4191;

/**
 * Forward /api/bkk/* to the local alert service, streaming the response so
 * the SSE endpoint stays open. Must be installed before apiNotFoundPlugin.
 */
export function bkkAlertProxy() {
  const install = (server) => {
    server.middlewares.use('/api/bkk', (req, res) => {
      const upstream = request(
        {
          host: TARGET_HOST,
          port: TARGET_PORT,
          method: req.method === 'POST' ? 'POST' : 'GET',
          path: `/api/bkk${req.url}`,
          headers: {
            accept: req.headers.accept || '*/*',
            ...(req.headers['content-type']
              ? { 'content-type': req.headers['content-type'] }
              : {}),
            // The alert service rate-limits reports per sender.
            'x-forwarded-for': req.socket.remoteAddress || '',
          },
        },
        (up) => {
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (res.headersSent) return res.end();
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'bkk-watch alert service is not running (npm run alert)',
          }),
        );
      });
      res.on('close', () => upstream.destroy());
      if (req.method === 'POST') req.pipe(upstream);
      else upstream.end();
    });
  };
  return {
    name: 'bkk-alert-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
