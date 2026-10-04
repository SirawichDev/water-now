import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rewriteHlsPlaylist,
  relayUrl,
  serveStatelessHls,
  statelessHlsEnabled,
} from './stateless.js';

const ORIGIN = 'https://camerai1.iticfoundation.org';
const BASE = `${ORIGIN}/pass/180.180.242.207:1935/Phase5/X.stream/playlist.m3u8`;
const LEASE = '0b5c5c8e-4f3a-4c1e-9a1b-1d2e3f4a5b6c';
const opts = {
  base: BASE,
  origin: ORIGIN,
  cameraId: 'itic-doh-x',
  lease: LEASE,
};
const unrelay = (line) => new URL(line, 'http://h').searchParams.get('u');

test('stateless HLS is on for Vercel or when asked', () => {
  assert.equal(statelessHlsEnabled({ VERCEL: '1' }), true);
  assert.equal(statelessHlsEnabled({ CCTV_STATELESS_HLS: '1' }), true);
  assert.equal(statelessHlsEnabled({}), false);
});

test('variant and segment references, relative or absolute, go through the relay', () => {
  const master =
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=245183\nchunklist_w1.m3u8\n';
  const out = rewriteHlsPlaylist(master, opts).split('\n');
  assert.equal(out[2], '#EXT-X-STREAM-INF:BANDWIDTH=245183');
  assert.match(out[3], /^\/api\/cctv\/media\/itic-doh-x\/u\?/);
  assert.equal(
    unrelay(out[3]),
    `${ORIGIN}/pass/180.180.242.207:1935/Phase5/X.stream/chunklist_w1.m3u8`,
  );
  assert.equal(new URL(out[3], 'http://h').searchParams.get('lease'), LEASE);

  const media = `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="${ORIGIN}/init.mp4"\n#EXTINF:9.6,\nmedia_1.ts\n#EXTINF:12.0,\r\n${ORIGIN}/abs/media_2.ts\r\n`;
  const lines = rewriteHlsPlaylist(media, opts).split('\n');
  assert.match(
    lines[2],
    /^#EXT-X-KEY:METHOD=AES-128,URI="\/api\/cctv\/media\/itic-doh-x\/u\?u=/,
  );
  assert.equal(
    unrelay(lines[2].match(/URI="([^"]+)"/)[1]),
    `${ORIGIN}/pass/180.180.242.207:1935/Phase5/X.stream/key.bin`,
  );
  assert.equal(
    unrelay(lines[3].match(/URI="([^"]+)"/)[1]),
    `${ORIGIN}/init.mp4`,
  );
  assert.equal(
    unrelay(lines[5]),
    `${ORIGIN}/pass/180.180.242.207:1935/Phase5/X.stream/media_1.ts`,
  );
  assert.equal(unrelay(lines[7]), `${ORIGIN}/abs/media_2.ts`);
  assert.equal(
    relayUrl('a b', `${ORIGIN}/x.ts`, ''),
    `/api/cctv/media/a%20b/u?u=${encodeURIComponent(`${ORIGIN}/x.ts`)}`,
  );
});

test('a reference to another origin is refused', () => {
  assert.throws(
    () =>
      rewriteHlsPlaylist(
        '#EXTM3U\n#EXTINF:2,\nhttps://evil.example/x.ts\n',
        opts,
      ),
    /escapes/,
  );
  assert.throws(
    () =>
      rewriteHlsPlaylist(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/k"\n',
        opts,
      ),
    /escapes/,
  );
});

/** A minimal Node-style response that records what was sent. */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? null;
    },
  };
}
const upstream = (map) => async (url) => {
  const hit = map[url];
  if (!hit) return new Response('nope', { status: 404 });
  return new Response(hit.body, {
    status: 200,
    headers: { 'content-type': hit.type || 'application/vnd.apple.mpegurl' },
  });
};
const source = { id: 'itic-doh-x', url: BASE, feedType: 'hls' };
const call = (path, fetchImpl, method = 'GET') => {
  const url = new URL(path, 'http://localhost');
  const res = fakeRes();
  return serveStatelessHls({
    req: { method },
    res,
    url,
    cameraId: 'itic-doh-x',
    source,
    relayed: url.pathname.endsWith('/u'),
    fetchImpl,
  }).then(() => res);
};

test('the camera playlist is relayed; segments come back as bytes', async () => {
  const seg = `${ORIGIN}/pass/180.180.242.207:1935/Phase5/X.stream/media_1.ts`;
  const fetchImpl = upstream({
    [BASE]: {
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.6,\nmedia_1.ts\n',
    },
    [seg]: { body: new Uint8Array([0x47, 1, 2, 3]), type: 'video/mp2t' },
  });
  const pl = await call(`/media/itic-doh-x?lease=${LEASE}`, fetchImpl);
  assert.equal(pl.status, 200);
  assert.equal(pl.headers['Cache-Control'], 'no-store');
  const segLine = pl.body.split('\n')[3];
  assert.equal(unrelay(segLine), seg);
  const ts = await call(segLine.replace('/api/cctv', ''), fetchImpl);
  assert.equal(ts.status, 200);
  assert.equal(ts.headers['Content-Type'], 'video/mp2t');
  assert.equal(ts.headers['Cache-Control'], 'public, max-age=60');
  assert.deepEqual([...ts.body], [0x47, 1, 2, 3]);
});

test('placeholders, foreign references, missing leases and DELETE', async () => {
  const placeholder =
    '#EXTM3U\n#EXT-X-TARGETDURATION:0\n#EXTINF:0.000000,\ncl2101.ts\n#EXT-X-ENDLIST\n';
  const dead = await call(
    `/media/itic-doh-x?lease=${LEASE}`,
    upstream({ [BASE]: { body: placeholder } }),
  );
  assert.equal(dead.status, 503);
  assert.deepEqual(JSON.parse(dead.body), { error: 'Live stream unavailable' });

  const foreign = await call(
    `/media/itic-doh-x/u?u=${encodeURIComponent('https://evil.example/x.ts')}&lease=${LEASE}`,
    upstream({}),
  );
  assert.equal(foreign.status, 403);

  assert.equal((await call('/media/itic-doh-x', upstream({}))).status, 400);
  assert.equal(
    (await call(`/media/itic-doh-x?lease=${LEASE}`, upstream({}), 'DELETE'))
      .status,
    204,
  );
  // Upstream down: same message the player already knows.
  assert.equal(
    (await call(`/media/itic-doh-x?lease=${LEASE}`, upstream({}))).status,
    503,
  );
});
