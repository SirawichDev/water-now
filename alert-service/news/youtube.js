// Latest uploads (and live streams) of a YouTube channel, without an API key.
// The official RSS feed is tried first; it fails often (404/500 on ~half of
// requests in testing), so the channel's own /videos and /streams pages are
// the fallback. Both are public pages; poll gently.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const decodeXml = (s) =>
  String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

export function parseRss(xml) {
  return [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, e]) => ({
      videoId: e.match(/<yt:videoId>([^<]+)</)?.[1],
      title: decodeXml(e.match(/<title>([^<]*)</)?.[1] || ''),
      description: decodeXml(
        e.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] ||
          '',
      ),
      publishedAt:
        Date.parse(e.match(/<published>([^<]+)</)?.[1] || '') || null,
      live: false,
    }))
    .filter((v) => v.videoId);
}

const UNIT_MS = {
  วินาที: 1e3,
  นาที: 60e3,
  ชั่วโมง: 3600e3,
  วัน: 86400e3,
  สัปดาห์: 7 * 86400e3,
  เดือน: 30 * 86400e3,
  ปี: 365 * 86400e3,
};
/** "35 นาทีที่แล้ว" / "สตรีมแล้วเมื่อ 2 ชั่วโมงที่ผ่านมา" → epoch ms (approx). */
export function parseThaiAgo(text, now = Date.now()) {
  const m = String(text || '').match(
    /(\d+)\s*(วินาที|นาที|ชั่วโมง|วัน|สัปดาห์|เดือน|ปี)/,
  );
  return m ? now - Number(m[1]) * UNIT_MS[m[2]] : null;
}

/** Pull lockup items out of a channel page's ytInitialData. */
export function parseChannelPage(
  html,
  { live = false, now = Date.now() } = {},
) {
  const m = String(html).match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return [];
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const out = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const lv = o.lockupViewModel;
    if (lv?.contentId && lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      const md = lv.metadata?.lockupMetadataViewModel;
      const parts = (md?.metadata?.contentMetadataViewModel?.metadataRows || [])
        .flatMap((r) => r.metadataParts || [])
        .map((p) => p.text?.content || '');
      const badges = JSON.stringify(lv.contentImage || {});
      out.push({
        videoId: lv.contentId,
        title: md?.title?.content || '',
        description: '',
        publishedAt:
          parts.map((p) => parseThaiAgo(p, now)).find(Boolean) || null,
        live: live && /LIVE|สด/.test(badges),
      });
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(data);
  return out;
}

async function get(url, fetchImpl, accept) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'th', Accept: accept },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function fetchChannelVideos(
  channelId,
  { fetchImpl = fetch } = {},
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const xml = await get(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
        fetchImpl,
        'application/atom+xml',
      );
      const items = parseRss(xml);
      if (items.length) return { via: 'rss', items };
    } catch {
      /* flaky feed: retry, then fall back */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const base = `https://www.youtube.com/channel/${channelId}`;
  const [videos, streams] = await Promise.all([
    get(`${base}/videos`, fetchImpl, 'text/html').catch(() => ''),
    get(`${base}/streams`, fetchImpl, 'text/html').catch(() => ''),
  ]);
  const items = [
    ...parseChannelPage(videos),
    ...parseChannelPage(streams, { live: true }),
  ];
  return { via: 'page', items };
}
