// A minimal connect-style stack for running the Vite provider plugins outside
// Vite (a Vercel function). Each plugin installs `(req, res, next)` handlers
// through `server.middlewares.use([path], fn)` in configurePreviewServer or
// configureServer; mounted paths are stripped from req.url as connect does.

/** Collect the middleware the plugins would install on a Vite server. */
export function collectMiddleware(plugins) {
  const layers = [];
  const server = {
    middlewares: {
      use(route, handle) {
        if (typeof route === 'function') [route, handle] = ['/', route];
        layers.push({ route: route.replace(/\/$/, '') || '/', handle });
        return server.middlewares;
      },
    },
    httpServer: null,
    config: {},
  };
  const post = [];
  for (const plugin of plugins) {
    const install = plugin.configurePreviewServer || plugin.configureServer;
    if (typeof install !== 'function') continue;
    // Vite runs a returned function after its own middleware: last here.
    const after = install.call(plugin, server);
    if (typeof after === 'function') post.push(after);
  }
  for (const after of post) after();
  return layers;
}

/** Does `route` cover `pathname`, and what is left of it below the route? */
export function matchRoute(route, pathname) {
  if (route === '/') return pathname;
  if (pathname === route) return '/';
  if (pathname.startsWith(`${route}/`)) return pathname.slice(route.length);
  return null;
}

/** `(req, res)` that runs the stack in order until one handler answers. */
export function createMiddlewareStack(plugins) {
  const layers = collectMiddleware(plugins);
  return (req, res) =>
    new Promise((resolve) => {
      const full = req.url;
      req.originalUrl ??= full;
      const [pathname, query = ''] = full.split(/\?(.*)/s);
      let i = 0;
      res.on('finish', resolve);
      res.on('close', resolve);
      const next = (err) => {
        req.url = full;
        if (err) {
          console.error(`[api] ${pathname}: ${err.message || err}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Server error' }));
          }
          return resolve();
        }
        while (i < layers.length) {
          const { route, handle } = layers[i++];
          const rest = matchRoute(route, pathname);
          if (rest == null) continue;
          req.url = `${rest}${query ? `?${query}` : ''}`;
          try {
            const out = handle(req, res, next);
            if (out?.catch) out.catch(next);
          } catch (e) {
            next(e);
          }
          return;
        }
        if (!res.headersSent) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown API route' }));
        }
        resolve();
      };
      next();
    });
}
