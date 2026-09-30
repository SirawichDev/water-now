import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex,
  matchPlaces,
  classifyTopics,
  headlineTexts,
} from './match.js';

const index = buildIndex([
  {
    name: 'แขวงคลองจั่น',
    kind: 'subdistrict',
    lat: 13.78,
    lon: 100.64,
    extentM: 1500,
  },
  { name: 'คลองจั่น', kind: 'canal', lat: 13.79, lon: 100.65, extentM: 0 },
  { name: 'เขตบางนา', kind: 'district', lat: 13.67, lon: 100.6, extentM: 3500 },
  {
    name: 'ซอยบางนา-ตราด 40',
    kind: 'soi',
    lat: 13.66,
    lon: 100.63,
    extentM: 200,
  },
  {
    name: 'ซอยลาดพร้าว 10',
    kind: 'soi',
    lat: 13.81,
    lon: 100.57,
    extentM: 300,
  },
  { name: 'ถนนลาดพร้าว', kind: 'road', lat: 13.79, lon: 100.6, extentM: 9000 },
  { name: 'ถนนวัฒนธรรม', kind: 'road', lat: 13.76, lon: 100.57, extentM: 900 },
  { name: 'ถนนเพชรบุรี', kind: 'road', lat: 13.75, lon: 100.55, extentM: 6000 },
  {
    name: 'แขวงจอมพล',
    kind: 'subdistrict',
    lat: 13.81,
    lon: 100.56,
    extentM: 1500,
  },
]);
const names = (text) => matchPlaces(text, index).map((p) => p.name);

test('the subdistrict beats a same-named canal; longest span wins', () => {
  assert.deepEqual(names('แฟลตคลองจั่น น้ำท่วมสูง 2 เมตร').slice(0, 1), [
    'แขวงคลองจั่น',
  ]);
  assert.deepEqual(names('น้ำท่วมซอยบางนา-ตราด 40'), ['ซอยบางนา-ตราด 40']);
});

test('numbers and Thai syllables are word boundaries', () => {
  assert.ok(!names('ซอยลาดพร้าว 101 น้ำลึก').includes('ซอยลาดพร้าว 10'));
  assert.deepEqual(names('ทนายตั้มแฉ กัน จอมพลัง'), []);
});

test('short roads are not matched bare; other provinces are not Bangkok', () => {
  assert.deepEqual(names('อ้างไม่รู้วัฒนธรรมไทย'), []);
  assert.deepEqual(names('น้ำท่วมเพชรบุรี ชาวบ้านอพยพ'), []);
  assert.deepEqual(names('ถนนเพชรบุรี กทม. รถติดยาว'), ['ถนนเพชรบุรี']);
});

test('show names repeated across a channel are ignored', () => {
  const items = ['A', 'B', 'C'].map((x, i) => ({
    videoId: String(i),
    title: `ข่าว ${x} | ข่าวลาดพร้าวเช้านี้ | 28/09/69`,
  }));
  items.push({
    videoId: '9',
    title: 'บางนาน้ำท่วม | ข่าวลาดพร้าวเช้านี้ | 28/09/69',
  });
  const texts = headlineTexts(items);
  assert.deepEqual(names(texts.get('0')), []);
  assert.deepEqual(names(texts.get('9')), ['เขตบางนา']);
});

test('topics come from Thai flood and outage vocabulary', () => {
  assert.deepEqual(classifyTopics('บางกะปิจมบาดาล ชาวบ้านอพยพ'), ['flood']);
  assert.deepEqual(classifyTopics('กฟน. แจ้งไฟดับหลายจุด'), ['outage']);
});

test('a soi named only by its number is not a place', () => {
  const idx = buildIndex([
    { name: 'ซอย 3', kind: 'soi', lat: 13.7, lon: 100.6, extentM: 100 },
    { name: 'ซอย๓', kind: 'soi', lat: 13.7, lon: 100.6, extentM: 100 },
    { name: 'ซอย ก', kind: 'soi', lat: 13.7, lon: 100.6, extentM: 100 },
    {
      name: 'ซอยสุขุมวิท 3',
      kind: 'soi',
      lat: 13.74,
      lon: 100.55,
      extentM: 300,
    },
  ]);
  assert.deepEqual(matchPlaces('น้ำท่วมขังปากซอย 3 รถติดยาว', idx), []);
  assert.deepEqual(matchPlaces('น้ำท่วมซอย ก เดือดร้อนหนัก', idx), []);
  assert.equal(
    matchPlaces('น้ำท่วมซอยสุขุมวิท 3', idx)[0]?.name,
    'ซอยสุขุมวิท 3',
  );
});
