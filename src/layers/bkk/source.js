// Snapshots from the local bkk-watch alert service (alert-service/), reached
// through the dev server's /api/bkk proxy. The service owns polling upstream;
// every browser reads its cache instead of hitting ThaiWater or MEA directly.
function createSnapshotSource(path, key, fetchImpl) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(path, { signal });
      if (!response.ok) throw new Error(`bkk-watch HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload?.[key]))
        throw new Error('Malformed bkk-watch response');
      return payload;
    },
  };
}

export function createBkkWaterSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createSnapshotSource('/api/bkk/water', 'stations', fetchImpl);
}

export function createBkkNewsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createSnapshotSource('/api/bkk/news', 'items', fetchImpl);
}

/** Live cameras come from GEV's own CCTV catalog, not the alert service. */
export function createBkkCamsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createSnapshotSource('/api/cctv/sources', 'sources', fetchImpl);
}

export function createBkkOutageSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createSnapshotSource('/api/bkk/outages', 'outages', fetchImpl);
}

// One EventSource shared by every subscriber: over HTTP/1.1 the browser
// allows 6 connections per host, and each open stream holds one for good.
// Where the service cannot hold a stream open (Vercel answers 204), the page
// polls /api/bkk/version instead and reports what changed.
const listeners = new Set();
let stream = null;
let poller = null;
const POLL_MS = 60_000;

const emit = (kind) => {
  for (const listener of listeners) listener(kind);
};

function startPolling() {
  if (poller) return;
  let last = null;
  const check = async () => {
    try {
      const res = await fetch('/api/bkk/version');
      if (!res.ok) return;
      const now = await res.json();
      if (last)
        for (const [kind, at] of Object.entries(now))
          if (at && at !== last[kind]) emit(kind);
      last = now;
    } catch {
      /* try again next round */
    }
  };
  check();
  poller = setInterval(check, POLL_MS);
}

/**
 * Call `onUpdate(kind)` whenever the service finishes a poll. Returns a stop
 * function. EventSource reconnects on its own after the service restarts.
 */
export function subscribeBkkUpdates(onUpdate) {
  listeners.add(onUpdate);
  if (typeof EventSource !== 'function') {
    startPolling();
  } else if (!stream && !poller) {
    let opened = false;
    stream = new EventSource('/api/bkk/stream');
    stream.addEventListener('open', () => {
      opened = true;
    });
    stream.addEventListener('error', () => {
      // A stream that never opened (or was told to stop) is not coming back.
      if (!opened || stream?.readyState === EventSource.CLOSED) {
        stream?.close();
        stream = null;
        startPolling();
      }
    });
    stream.addEventListener('update', (event) => {
      let kind;
      try {
        kind = JSON.parse(event.data).kind;
      } catch {
        return;
      }
      emit(kind);
    });
  }
  return () => {
    listeners.delete(onUpdate);
    if (listeners.size) return;
    stream?.close();
    stream = null;
    clearInterval(poller);
    poller = null;
  };
}
