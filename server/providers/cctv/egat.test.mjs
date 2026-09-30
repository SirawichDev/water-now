import test from 'node:test';
import assert from 'node:assert/strict';
import { EGAT_DAMS, egatViewToSource, loadEgatDamSources } from './egat.js';

test('a dam view becomes a still-image source in its province', () => {
  const dam = EGAT_DAMS.find((d) => d[0] === 'SNR');
  const source = egatViewToSource(dam, 2, { stale: false, label: '' });
  assert.equal(source.id, 'egat-snr-2');
  assert.equal(source.name, 'เขื่อนศรีนครินทร์ · มุม 2');
  assert.equal(source.city, 'กาญจนบุรี');
  assert.equal(source.feedType, 'image');
  assert.equal(
    source.snapshotUrl,
    'https://egatwater.egat.co.th/assets/CCTV/images/SNR/2.jpg',
  );
  // Views of one dam sit in a ring around it, within about 60 m.
  assert.ok(Math.abs(source.lat - dam[3]) <= 0.0006);
  assert.ok(Math.abs(source.lon - dam[4]) <= 0.0006);
  assert.notDeepEqual(
    [source.lat, source.lon],
    [egatViewToSource(dam, 1).lat, egatViewToSource(dam, 1).lon],
  );
  // A stalled picture says so in its name.
  assert.match(
    egatViewToSource(dam, 1, {
      stale: true,
      label: 'ภาพค้าง · ภาพล่าสุด 1 ก.ย. 08:00',
    }).name,
    /ภาพค้าง/,
  );
});

test('only views whose image answers are loaded', async () => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push([url, init.method]);
    const ok = /\/(BB|UR)\/1\.jpg$/.test(url);
    return {
      ok,
      headers: new Map([
        ['content-type', ok ? 'image/jpeg' : 'text/html'],
        ['last-modified', new Date().toUTCString()],
      ]),
    };
  };
  const sources = await loadEgatDamSources({ fetchImpl });
  const views = EGAT_DAMS.reduce((n, d) => n + d[5], 0);
  assert.equal(asked.length, views);
  assert.ok(asked.every(([, method]) => method === 'HEAD'));
  assert.deepEqual(sources.map((s) => s.id).sort(), ['egat-bb-1', 'egat-ur-1']);
  // A single-view dam stays exactly on its point.
  const ur = sources.find((s) => s.id === 'egat-ur-1');
  assert.deepEqual([ur.lat, ur.lon], [16.75267, 102.632545]);
});
