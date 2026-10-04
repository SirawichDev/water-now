import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { matchRoute, createMiddlewareStack } from './middleware-stack.js';

test('routes match whole path segments and are stripped like connect', () => {
  assert.equal(matchRoute('/api/cctv', '/api/cctv/media/x'), '/media/x');
  assert.equal(matchRoute('/api/cctv', '/api/cctv'), '/');
  assert.equal(matchRoute('/api/cctv', '/api/cctvx'), null);
  assert.equal(matchRoute('/', '/api/x'), '/api/x');
});

/** A response that records what was written. */
function fakeRes() {
  const res = new PassThrough();
  res.headersSent = false;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
    res.headersSent = true;
  };
  const end = res.end.bind(res);
  res.end = (body) => {
    res.body = String(body ?? '');
    end();
    res.emit('finish');
  };
  return res;
}

test('the stack runs plugin middleware in order, with next and a 404 at the end', async () => {
  const seen = [];
  const plugin = (name, route, handle) => ({
    name,
    configurePreviewServer: (server) => server.middlewares.use(route, handle),
  });
  const stack = createMiddlewareStack([
    plugin('a', '/api/a', (req, res, next) => {
      seen.push(`a:${req.url}`);
      next();
    }),
    plugin('b', '/api/a', (req, res) => {
      seen.push(`b:${req.url}`);
      res.writeHead(200, {});
      res.end('ok');
    }),
    { name: 'dev-only', configureServer: () => {} },
  ]);
  const res = fakeRes();
  await stack({ url: '/api/a/x?y=1' }, res);
  assert.deepEqual(seen, ['a:/x?y=1', 'b:/x?y=1']);
  assert.equal(res.body, 'ok');

  const missing = fakeRes();
  await stack({ url: '/api/zzz' }, missing);
  assert.equal(missing.status, 404);
});
