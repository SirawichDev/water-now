// YouTube news → Bangkok places → map items and alerts.
// Unit of placement is one clip: a 24/7 live channel covers many places, so
// each upload/stream is matched on its own headline.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchChannelVideos } from './youtube.js';
import {
  loadIndex,
  matchPlaces,
  classifyTopics,
  headlineTexts,
  normalize,
  TOPICS,
} from './match.js';
import { distanceM } from '../engine.js';
import { extractDepth } from './depth.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ALERT_TOPICS = new Set(['flood', 'outage', 'fire']);
const KEEP_MS = 48 * 3600_000;
const ALERT_FRESH_MS = 3 * 3600_000; // never alert on old clips (first run)
const TOPIC_LABEL = Object.fromEntries(TOPICS.map((t) => [t.id, t.label]));

export function createNewsEngine({
  db,
  core,
  channelsPath = here('./channels.json'),
  gazetteerPath = here('../gazetteer/bangkok.json'),
  fetchVideos = fetchChannelVideos,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS news (
    video_id   TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    first_seen INTEGER NOT NULL
  )`);
  const q = {
    get: db.prepare('SELECT json, first_seen FROM news WHERE video_id = ?'),
    put: db.prepare(
      'INSERT OR REPLACE INTO news (video_id, json, first_seen) VALUES (?, ?, ?)',
    ),
    recent: db.prepare('SELECT json FROM news WHERE first_seen > ?'),
  };
  const index = loadIndex(gazetteerPath);
  const channels = JSON.parse(readFileSync(channelsPath, 'utf8'));
  const state = { updatedAt: null, error: null, items: [], channels: {} };

  function toItem(video, channel, text, firstSeen) {
    const places = matchPlaces(text, index).slice(0, 4);
    const primary = places[0] || null;
    return {
      id: video.videoId,
      channel: channel.name,
      title: video.title,
      url: `https://www.youtube.com/watch?v=${video.videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`,
      live: Boolean(video.live),
      publishedAt: video.publishedAt || firstSeen,
      firstSeen,
      topics: classifyTopics(text),
      // Street depth as the headline states it, e.g. { cm: 150, text: '1.5 เมตร' }.
      depth: extractDepth(video.title),
      places: places.map(({ name, kind, lat, lon, extentM }) => ({
        name,
        kind,
        lat,
        lon,
        extentM,
      })),
      lat: primary?.lat ?? null,
      lon: primary?.lon ?? null,
      extentM: primary?.extentM ?? null,
      zone: primary?.name ?? null,
    };
  }

  function alertText(item) {
    const topic = item.topics.map((t) => TOPIC_LABEL[t]).join(' · ');
    return [
      `📰 ข่าว${topic ? ` ${topic}` : ''} ใกล้คุณ — ${item.zone}`,
      item.title,
      `${item.channel}${item.live ? ' · 🔴 LIVE' : ''}`,
      item.url,
    ].join('\n');
  }

  /** Subscribers whose circle overlaps the place's own spread. */
  function recipients(item) {
    const ids = [];
    if (item.lat != null)
      for (const s of core.subscribers())
        if (
          distanceM(s.lat, s.lon, item.lat, item.lon) <=
          s.radius_m + (item.extentM || 0)
        )
          ids.push(s.chat_id);
    const title = normalize(item.title);
    for (const k of core.keywordWatches())
      if (title.includes(normalize(k.keyword))) ids.push(k.chat_id);
    return ids;
  }

  async function pollNews() {
    const now = Date.now();
    const errors = [];
    for (const channel of channels) {
      try {
        const { via, items } = await fetchVideos(channel.id);
        state.channels[channel.name] = { via, count: items.length, at: now };
        const texts = headlineTexts(items);
        for (const video of items) {
          const known = q.get.get(video.videoId);
          const firstSeen = known?.first_seen ?? now;
          const item = toItem(
            video,
            channel,
            texts.get(video.videoId),
            firstSeen,
          );
          q.put.run(item.id, JSON.stringify(item), firstSeen);
          const fresh = now - (item.publishedAt || firstSeen) < ALERT_FRESH_MS;
          if (
            fresh &&
            item.zone &&
            item.topics.some((t) => ALERT_TOPICS.has(t))
          )
            await core.deliver(
              `news:${item.id}`,
              recipients(item),
              alertText(item),
            );
        }
      } catch (e) {
        errors.push(`${channel.name}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 1500)); // be gentle with YouTube
    }
    const items = q.recent
      .all(now - KEEP_MS)
      .map((r) => JSON.parse(r.json))
      .filter((i) => i.zone && now - (i.publishedAt || i.firstSeen) < KEEP_MS)
      .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    state.items = items;
    state.updatedAt = now;
    state.error = errors.length ? errors.join('; ') : null;
    core.events.emit('update', 'news');
  }

  return { state, pollNews };
}
