import test from 'node:test';
import assert from 'node:assert/strict';
import { iticCameraToSource, isPlayablePlaylist } from './itic.js';

const row = {
  title: '(กรุงเทพมหานคร) เชิงสะพานตากสิน ฝั่งสาทร',
  camid: 'ITICM_BMAMI0080',
  latitude: '13.718527',
  longitude: '100.515279',
  organization: 'iTIC Motion',
  hls_url: 'https://camera1.iticfoundation.org/hls/10.8.0.18_8002.m3u8',
};

test('iTIC rows with an HTTPS iTIC stream become HLS sources', () => {
  const source = iticCameraToSource(row);
  assert.equal(source.id, 'itic-iticm_bmami0080');
  assert.equal(source.name, 'เชิงสะพานตากสิน ฝั่งสาทร');
  assert.equal(source.cityId, 'bangkok');
  assert.equal(source.feedType, 'hls');
  assert.equal(source.url, row.hls_url);
});

test('provinces become their own city; bad hosts and coordinates are dropped', () => {
  const nakhon = iticCameraToSource({
    ...row,
    camid: 'DOH-4-001',
    title: '(จ.นครปฐม) 4 - อ.นครชัยศรี',
    latitude: '13.80',
    longitude: '100.19',
  });
  assert.equal(nakhon.city, 'นครปฐม');
  assert.match(nakhon.cityId, /^th-[0-9a-f]{8}$/);
  assert.equal(nakhon.name, '4 - อ.นครชัยศรี');
  assert.equal(
    iticCameraToSource({
      ...row,
      hls_url:
        'http://180.180.242.207:1935/Phase3/PER_3_008_IN.stream/chunklist.m3u8',
    }),
    null,
  );
  assert.equal(
    iticCameraToSource({ ...row, hls_url: 'https://evil.example/x.m3u8' }),
    null,
  );
  assert.equal(iticCameraToSource({ ...row, latitude: '35.0' }), null);
  assert.equal(iticCameraToSource({ ...row, title: 'no province' }), null);
});

test('the placeholder an offline camera serves is not playable', () => {
  // What iTIC served for ITICM_BMAMI0211 on 1 Oct 2026.
  const placeholder =
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:0\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:0.000000,\ncl2101.ts\n#EXT-X-ENDLIST\n';
  assert.equal(isPlayablePlaylist(placeholder), false);
  assert.equal(
    isPlayablePlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n',
    ),
    true,
  );
  assert.equal(
    isPlayablePlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=245183\nchunklist.m3u8\n',
    ),
    true,
  );
  assert.equal(isPlayablePlaylist('<html>502</html>'), false);
});
