// The service as a long-lived local process: polls on timers, serves the API
// with an SSE stream, and long-polls Telegram. On Vercel the same app runs
// from api/index.js instead (see app.js).
import { config } from './config.js';
import { createApp } from './app.js';
import { createHttpServer } from './server.js';

const app = await createApp(config);
const { engine, news, history, nearby, hail, telegram } = app;

const controller = new AbortController();
if (telegram)
  telegram
    .run(controller.signal)
    .catch((e) => console.error(`[telegram] stopped: ${e.message}`));
else
  console.log('[telegram] TELEGRAM_BOT_TOKEN not set — alerts are logged only');

engine.events.on('update', (kind) => {
  // Hail zones are recomputed whenever a headline or a resident report
  // arrives; the hail poll adds the Meteorological Department and the model.
  if (kind === 'news' || kind === 'reports')
    hail
      .refresh({ fresh: true })
      .catch((e) => console.warn(`[hail] ${e.message}`));
  if (kind !== 'water') return;
  // Keep the replay's hourly table current; backfill runs in the background.
  history
    .record(engine.state.water.stations)
    .catch((e) => console.warn(`[history] record failed: ${e.message}`));
  history
    .backfill(engine.state.water.stations, { signal: controller.signal })
    .then((n) => n && console.log(`[history] backfilled ${n} stations`))
    .catch((e) => console.warn(`[history] backfill failed: ${e.message}`));
  // Pre-fetch shops and hospitals around every over-bank gauge, worst first.
  const worst = engine.state.water.stations
    .filter((s) => !s.stale && s.level >= 5)
    .sort((a, b) => b.storagePercent - a.storagePercent);
  nearby.warm(worst, { signal: controller.signal });
});

createHttpServer(app, {
  userAgent: config.userAgent,
  cronSecret: config.cronSecret,
}).listen(config.port, config.host, () =>
  console.log(
    `[http] http://${config.host}:${config.port}/api/bkk/health (${app.store.kind})`,
  ),
);

/** Run a poll now and then on its interval, never overlapping itself. */
function every(ms, fn) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.warn(`[poll] ${e.message}`);
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
every(config.hailPollMs, hail.poll);

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => {
    controller.abort();
    await app.store.close();
    process.exit(0);
  });
