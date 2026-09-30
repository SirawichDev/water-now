import { config } from './config.js';
import { openDb } from './db.js';
import { createGeocoder } from './geocode.js';
import { createEngine } from './engine.js';
import { createTelegram } from './telegram.js';
import { createHttpServer } from './server.js';
import { createNewsEngine } from './news/engine.js';
import { createNearby } from './sources/nearby.js';
import { createReports } from './reports.js';
import { createHistory } from './history.js';

const db = openDb(config.dbPath);
const geocoder = createGeocoder({ db, userAgent: config.userAgent });

// Without a bot token the service still serves the map; alerts go to the log.
let telegram = null;
const notifier = {
  send: (chatId, text) =>
    telegram
      ? telegram.send(chatId, text)
      : Promise.resolve(console.log(`[dry-run → ${chatId}]\n${text}\n`)),
};
const engine = createEngine({ db, config, geocoder, notifier });
const news = config.newsEnabled ? createNewsEngine({ db, core: engine }) : null;

const controller = new AbortController();
if (config.telegramToken) {
  telegram = createTelegram({
    token: config.telegramToken,
    db,
    config,
    engine,
  });
  telegram
    .run(controller.signal)
    .catch((e) => console.error(`[telegram] stopped: ${e.message}`));
} else {
  console.log('[telegram] TELEGRAM_BOT_TOKEN not set — alerts are logged only');
}

const nearby = createNearby({ userAgent: config.userAgent, db });
const history = createHistory({ db, userAgent: config.userAgent });
// Pre-fetch shops and hospitals around every over-bank gauge, worst first.
engine.events.on('update', (kind) => {
  if (kind !== 'water') return;
  // Keep the replay's hourly table current; backfill runs in the background.
  try {
    history.record(engine.state.water.stations);
  } catch (e) {
    console.warn(`[history] record failed: ${e.message}`);
  }
  history
    .backfill(engine.state.water.stations, { signal: controller.signal })
    .then((n) => n && console.log(`[history] backfilled ${n} stations`))
    .catch((e) => console.warn(`[history] backfill failed: ${e.message}`));
  const worst = engine.state.water.stations
    .filter((s) => !s.stale && s.level >= 5)
    .sort((a, b) => b.storagePercent - a.storagePercent);
  nearby.warm(worst, { signal: controller.signal });
});

createHttpServer({
  engine,
  news,
  nearby,
  reports: createReports({ db }),
  timeline: history,
  userAgent: config.userAgent,
}).listen(config.port, config.host, () =>
  console.log(`[http] http://${config.host}:${config.port}/api/bkk/health`),
);

/** Run a poll now and then on its interval, never overlapping itself. */
function every(ms, fn) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, ms);
}
every(config.waterPollMs, engine.pollWater);
every(config.outagePollMs, engine.pollOutages);
if (news) every(config.newsPollMs, news.pollNews);

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    controller.abort();
    db.close();
    process.exit(0);
  });
