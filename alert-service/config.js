import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));

/** Read KEY=VALUE lines from alert-service/.env without overriding the shell. */
function loadDotenv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotenv(`${root}.env`);

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export const config = Object.freeze({
  port: num(process.env.BKK_ALERT_PORT, 4191),
  host: process.env.BKK_ALERT_HOST || '127.0.0.1',
  dbPath: process.env.BKK_ALERT_DB || `${root}data/bkk-alert.db`,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  waterPollMs: num(process.env.WATER_POLL_MS, 5 * 60_000),
  outagePollMs: num(process.env.OUTAGE_POLL_MS, 30 * 60_000),
  // A reading older than this is shown but never alerted on.
  waterStaleMs: num(process.env.WATER_STALE_MS, 3 * 3600_000),
  defaultRadiusM: num(process.env.DEFAULT_RADIUS_M, 3000),
  outageReminderMs: num(process.env.OUTAGE_REMINDER_MS, 60 * 60_000),
  newsPollMs: num(process.env.NEWS_POLL_MS, 10 * 60_000),
  newsEnabled: process.env.NEWS_ENABLED !== '0',
  userAgent:
    'bkk-watch/0.1 (local dev; github.com/bilawalsidhu/gods-eye-view fork)',
});
