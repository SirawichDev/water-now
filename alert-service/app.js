// Wires the service's parts together once, for both ways it runs: as a
// long-lived local process (index.js) and as Vercel functions (api/index.js),
// where nothing runs between requests and an external scheduler calls
// /api/bkk/cron to run whatever polls are due.
import { openStore, snapshotTimes, tryLock, unlock } from './store.js';
import { createGeocoder } from './geocode.js';
import { createEngine } from './engine.js';
import { createTelegram } from './telegram.js';
import { createNewsEngine } from './news/engine.js';
import { createNearby } from './sources/nearby.js';
import { createReports } from './reports.js';
import { createHistory } from './history.js';
import { createHail } from './hail.js';

// A poll is due once its snapshot is this old. A little under each interval,
// so a scheduler firing every 5 min never skips a round by a few seconds.
const DUE = { water: 4.5, outages: 29, news: 9.5, hail: 4.5 };
const POLL_LOCK_MS = 280_000; // under Vercel's 300 s function limit
const BACKFILL_PER_RUN = 12;

/**
 * @param {object} config  from config.js
 * @param {object} [opts]
 * @param {object} [opts.notifier]  overrides Telegram (tests, dry runs)
 */
export async function createApp(config, { notifier: given } = {}) {
  const store = await openStore({
    url: config.databaseUrl,
    path: config.dbPath,
  });
  const geocoder = createGeocoder({ db: store, userAgent: config.userAgent });
  const telegram = config.telegramToken
    ? createTelegram({
        token: config.telegramToken,
        db: store,
        config,
        engine: null,
      })
    : null;
  const notifier = given || {
    send: (chatId, text) =>
      telegram
        ? telegram.send(chatId, text)
        : Promise.resolve(console.log(`[dry-run → ${chatId}]\n${text}\n`)),
  };
  const engine = createEngine({ db: store, config, geocoder, notifier });
  telegram?.attach(engine);
  const news = config.newsEnabled
    ? createNewsEngine({ db: store, core: engine })
    : null;
  const nearby = createNearby({ userAgent: config.userAgent, db: store });
  const history = createHistory({ db: store, userAgent: config.userAgent });
  const reports = createReports({ db: store, salt: config.reportSalt });
  const hail = createHail({
    engine,
    db: store,
    reports,
    getNews: () => (news ? news.recentItems() : Promise.resolve([])),
    userAgent: config.userAgent,
  });

  /** When each kind of data last changed: what browsers poll for. */
  async function versions() {
    const times = await snapshotTimes(store);
    return { ...times, reports: await reports.latestAt() };
  }

  /**
   * Run every poll whose data is older than its interval, once at a time
   * across all processes. `force` names polls to run regardless ("all").
   */
  async function runDue({ force = '' } = {}) {
    const now = Date.now();
    if (!(await tryLock(store, 'poll', POLL_LOCK_MS, now)))
      return { skipped: 'another poll is running' };
    const forced = new Set(String(force || '').split(','));
    const times = await snapshotTimes(store);
    const due = (kind) =>
      forced.has('all') ||
      forced.has(kind) ||
      now - (times[kind] || 0) >= DUE[kind] * 60_000;
    const ran = [];
    try {
      if (due('water')) {
        await engine.pollWater();
        const { stations } = engine.state.water;
        await history.record(stations);
        await history.backfill(stations, { limit: BACKFILL_PER_RUN });
        ran.push('water');
      }
      if (due('outages')) {
        await engine.pollOutages();
        ran.push('outages');
      }
      if (news && due('news')) {
        await news.pollNews();
        ran.push('news');
      }
      if (due('hail') || ran.includes('news')) {
        await hail.poll();
        ran.push('hail');
      }
    } finally {
      await unlock(store, 'poll');
    }
    return { ran, at: now };
  }

  return {
    config,
    store,
    engine,
    news,
    nearby,
    history,
    reports,
    hail,
    telegram,
    versions,
    runDue,
  };
}
