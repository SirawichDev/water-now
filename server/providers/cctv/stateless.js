// bkk-watch: a stateless HLS relay for serverless hosts (Vercel). The local
// puller (./stream.js) keeps sessions and segments in one process's memory;
// on a host with many short-lived instances a segment request can land on an
// instance that never saw the session. Here every request stands alone: the
// playlist is fetched and its references are rewritten to point back through
// this relay, and each relayed reference is fetched on its own.
import { isPlayablePlaylist } from './itic.js';

export const STATELESS_HLS_LIMITS = Object.freeze({
  playlistBytes: 256 * 1024,
  // Under Vercel's 4.5 MB response cap.
  segmentBytes: 4 * 1024 * 1024,
  timeoutMs: 10000,
});

/** On when running on Vercel, or when asked for explicitly. */
export function statelessHlsEnabled(env = process.env) {
  return Boolean(env.VERCEL) || env.CCTV_STATELESS_HLS === '1';
}

/** The relay URL for one upstream reference of a camera's stream. */
export function relayUrl(cameraId, upstream, lease) {
  const params = new URLSearchParams({ u: upstream });
  if (lease) params.set('lease', lease);
  return `/api/cctv/media/${encodeURIComponent(cameraId)}/u?${params}`;
}

/** Absolute URL for a reference, refused when it leaves the camera's origin. */
export function sameOriginReference(value, base, origin) {
  const url = new URL(value, base);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.origin !== origin ||
    url.username ||
    url.password
  )
    throw new Error('HLS reference escapes the camera origin');
  return url.href;
}

/**
 * Rewrite every reference in a playlist (variant playlists, segments, and
 * URI="…" attributes such as EXT-X-KEY / EXT-X-MAP) to go through the relay.
 * Throws when any reference points outside `origin`.
 */
export function rewriteHlsPlaylist(text, { base, origin, cameraId, lease }) {
  const relay = (value) =>
    relayUrl(cameraId, sameOriginReference(value, base, origin), lease);
  return String(text)
    .split('\n')
    .map((raw) => {
      const line = raw.replace(/\r$/, '');
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#'))
        return line.replace(
          /URI="([^"]*)"/g,
          (_, value) => `URI="${relay(value)}"`,
        );
      return relay(trimmed);
    })
    .join('\n');
}

const looksLikePlaylist = (contentType, bytes) =>
  /mpegurl/i.test(contentType || '') ||
  bytes.subarray(0, 7).toString('latin1') === '#EXTM3U';

/** Fetch one upstream URL: no redirects, a timeout, and a byte cap. */
export async function fetchRelayed(
  url,
  {
    fetchImpl = fetch,
    maxBytes = STATELESS_HLS_LIMITS.segmentBytes,
    timeoutMs = STATELESS_HLS_LIMITS.timeoutMs,
    signal,
  } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let reader;
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'error',
      signal: controller.signal,
      headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
    });
    if (
      !response.ok ||
      response.redirected ||
      (response.url && new URL(response.url).href !== new URL(url).href)
    )
      throw new Error(`HLS upstream refused (${response.status})`);
    if (Number(response.headers.get('content-length')) > maxBytes)
      throw new Error('HLS response too large');
    reader = response.body?.getReader?.();
    const chunks = [];
    let length = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) throw new Error('HLS response too large');
        chunks.push(Buffer.from(value));
      }
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('HLS response too large');
      chunks.push(buf);
      length = buf.length;
    }
    return {
      bytes: Buffer.concat(chunks, length),
      contentType: response.headers.get('content-type') || '',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (reader) reader.releaseLock?.();
  }
}

const sendJson = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
};
const LEASE = /^[a-f0-9-]{36}$/i;
const UNAVAILABLE = { error: 'Live stream unavailable' };

/**
 * Serve `/media/:id` (the camera's playlist) or `/media/:id/u?u=…` (one
 * relayed reference) for an HLS camera, without any state between requests.
 * @returns {Promise<void>}
 */
export async function serveStatelessHls({
  req,
  res,
  url,
  cameraId,
  source,
  relayed,
  fetchImpl = fetch,
}) {
  const lease = url.searchParams.get('lease') || '';
  if (!LEASE.test(lease)) {
    res.writeHead(400);
    res.end();
    return;
  }
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  let cameraUrl;
  try {
    cameraUrl = new URL(source?.url || '');
    if (!['https:', 'http:'].includes(cameraUrl.protocol))
      throw new Error('bad scheme');
    if (!/\.m3u8(?:\?|$)/i.test(cameraUrl.href)) throw new Error('not HLS');
  } catch {
    sendJson(res, 503, {
      error:
        'This stream requires an unsupported transport; use the frame fallback',
    });
    return;
  }
  const origin = cameraUrl.origin;

  let target = cameraUrl.href;
  if (relayed) {
    try {
      target = sameOriginReference(
        url.searchParams.get('u') || '',
        target,
        origin,
      );
    } catch {
      sendJson(res, 403, { error: 'Reference outside the camera origin' });
      return;
    }
  }

  let fetched;
  try {
    fetched = await fetchRelayed(target, {
      fetchImpl,
      maxBytes: relayed
        ? STATELESS_HLS_LIMITS.segmentBytes
        : STATELESS_HLS_LIMITS.playlistBytes,
    });
  } catch {
    sendJson(res, 503, UNAVAILABLE);
    return;
  }

  if (!relayed || looksLikePlaylist(fetched.contentType, fetched.bytes)) {
    const text = fetched.bytes.toString('utf8');
    // An offline iTIC camera answers with a placeholder playlist.
    if (!text.startsWith('#EXTM3U') || !isPlayablePlaylist(text)) {
      sendJson(res, 503, UNAVAILABLE);
      return;
    }
    let body;
    try {
      body = rewriteHlsPlaylist(text, {
        base: target,
        origin,
        cameraId,
        lease,
      });
    } catch {
      sendJson(res, 503, UNAVAILABLE);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
      'X-CCTV-Source': 'hls-relay',
    });
    res.end(body);
    return;
  }

  res.writeHead(200, {
    'Content-Type': fetched.contentType || 'video/mp2t',
    'Content-Length': String(fetched.bytes.length),
    'Cache-Control': 'public, max-age=60',
  });
  res.end(fetched.bytes);
}
