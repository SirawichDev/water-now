import test from 'node:test';
import assert from 'node:assert/strict';
import { createBkkPointLayer } from './pointLayer.js';

test('a refresh replaces the drawn points, so a changed colour shows', async () => {
  let color = '#9ca3af';
  let dataSource = null;
  const viewer = {
    dataSources: { add: (ds) => (dataSource = ds), remove() {} },
    scene: { requestRender() {} },
  };
  const layer = createBkkPointLayer({
    id: 'test-points',
    name: 'Test',
    icon: '•',
    sourceLabel: 'test',
    kind: 'water',
    listKey: 'stations',
    source: {
      getSnapshot: async () => ({ stations: [{ id: 'a', lat: 14, lon: 100 }] }),
    },
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    toPoint: (st) => ({ ...st, color, size: 4, edge: 0 }),
  });
  layer.init(viewer);
  layer.enable();
  try {
    assert.equal(await layer.update(), true);
    const events = [];
    dataSource.entities.collectionChanged.addEventListener(
      (_collection, added, removed) =>
        events.push({ added: added.length, removed: removed.length }),
    );
    color = '#36405a';
    assert.equal(await layer.update(), true);
    // Cesium's visualizers only redraw what these events report. The same id
    // removed and re-added in one batch would report nothing at all.
    assert.deepEqual(events, [
      { added: 0, removed: 1 },
      { added: 1, removed: 0 },
    ]);
    const [entity] = dataSource.entities.values;
    assert.equal(entity.point.color.getValue().toCssHexString(), '#36405a');
    assert.equal(
      entity.point.outlineColor.getValue().toCssHexString(),
      '#36405a', // an edgeless point has no white rim
    );
  } finally {
    layer.destroy(viewer);
  }
});
