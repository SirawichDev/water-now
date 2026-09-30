import * as Cesium from 'cesium';
import { subscribeBkkUpdates } from './source.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/**
 * One Bangkok point layer: fetch a snapshot, map each record to a styled
 * point, and refetch when the alert service announces an update.
 * `toPoint(record, now)` returns null to skip a record, or
 * { id, lat, lon, color, size, label, priority, halo?, edge?,
 * ring?: { radiusM, color }, properties }.
 * Labels go through GEV's HTML world overlay rather than Cesium labels:
 * Cesium lays text out glyph by glyph and misplaces Thai vowels and tone
 * marks, while the overlay uses the browser's text shaping and its collision
 * budget keeps dense areas readable.
 * `onPick(record)` makes points clickable (the record `prepare` produced);
 * `onData(records)` sees every refresh.
 */
export function createBkkPointLayer({
  id,
  name,
  icon,
  sourceLabel,
  kind,
  source,
  listKey,
  toPoint,
  overlayHost,
  prepare = (records) => records,
  onPick = null,
  onData = null,
  updateInterval = 60_000,
}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError(`${id} requires a snapshot source`);
  if (!overlayHost) throw new TypeError(`${id} requires an overlay host`);
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _hidden = false;
  let _stopStream = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _clicks = null;
  const _records = new Map(); // entity id → prepared record
  const ownsPick = (pickedId) => String(pickedId).startsWith(`${id}:`);

  function installClicks(viewer) {
    if (!onPick || _clicks || !viewer?.scene) return;
    registerPickOwner(id, ownsPick);
    _clicks = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clicks.setInputAction((click) => {
      if (!isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const entityId = picked?.id?.id;
      if (typeof entityId === 'string' && _records.has(entityId))
        onPick(_records.get(entityId));
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClicks() {
    _clicks?.destroy();
    _clicks = null;
    unregisterPickOwner(id);
  }

  const layer = {
    id,
    name,
    icon,
    source: sourceLabel,
    updateInterval,

    init(viewer) {
      if (_viewer) throw new Error(`${id} is already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(id, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = !_hidden;
      overlayHost.setVisible(id, true);
      installClicks(_viewer);
      _stopStream ??= subscribeBkkUpdates((updated) => {
        if (updated === kind && _enabled) layer.update(_viewer);
      });
    },

    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      _stopStream?.();
      _stopStream = null;
      removeClicks();
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(id);
      overlayHost.setVisible(id, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const payload = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const now = Date.now();
        const entities = [];
        const labels = [];
        const records = prepare(payload[listKey], now);
        _records.clear();
        for (const record of records) {
          const p = toPoint(record, now);
          if (!p) continue;
          _records.set(`${id}:${p.id}`, record);
          const position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat);
          const color = Cesium.Color.fromCssColorString(p.color);
          if (p.label)
            labels.push({
              id: String(p.id),
              position,
              variant: 'label',
              title: p.label,
              accent: p.color,
              priority: p.priority ?? 0,
              collisionGroup: 'ambient-label',
              paintLane: 'ambient-label',
              interactive: false,
              // No keyhole fade: simple mode has no scope mask, and a
              // label near the screen edge is as useful as one in the middle.
              edgeFade: 'none',
              horizonCull: true,
              terrainOcclusion: false,
              gapPx: 12,
              verticalOnly: true,
              placement: 'above',
            });
          entities.push(
            new Cesium.Entity({
              id: `${id}:${p.id}`,
              position,
              point: {
                pixelSize: p.size,
                color,
                // `halo` draws a soft ring in the point's own colour instead
                // of the default white edge.
                // An edgeless point keeps its own colour at the rim; a
                // white rim would show through as a pale fringe.
                outlineColor: p.halo
                  ? color.withAlpha(0.22)
                  : p.edge === 0
                    ? color
                    : Cesium.Color.WHITE,
                outlineWidth: p.halo ?? p.edge ?? 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
              ...(p.ring
                ? {
                    ellipse: {
                      semiMajorAxis: p.ring.radiusM,
                      semiMinorAxis: p.ring.radiusM,
                      // No height and no outline: Cesium drapes it on the
                      // terrain as a ground primitive, which cannot outline.
                      material: Cesium.Color.fromCssColorString(
                        p.ring.color,
                      ).withAlpha(0.18),
                    },
                  }
                : {}),
              properties: p.properties,
            }),
          );
        }
        // Remove first, as its own event. Inside one suspended batch Cesium
        // cancels a removal against an addition with the same id, so the
        // visualizers would keep drawing the old entity and its old colour.
        _dataSource.entities.removeAll();
        _dataSource.entities.suspendEvents();
        for (const entity of entities) _dataSource.entities.add(entity);
        _dataSource.entities.resumeEvents();
        if (_enabled)
          overlayHost.setEntries(id, labels, {
            cohortLimit: 64,
            collisionCapacity: 40,
            moving: false,
          });
        _viewer?.scene?.requestRender();
        onData?.(records);
        _count = entities.length;
        _lastUpdate = payload.updatedAt || now;
        _lastError = payload.error || null;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _lastError = e?.message || `${name} unavailable`;
        console.warn(`[Data:${id}]`, _lastError);
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      if (_dataSource) {
        viewer?.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /** Hide the points without disabling the layer (e.g. during a replay). */
    setVisible(visible) {
      _hidden = !visible;
      if (_dataSource) _dataSource.show = _enabled && !_hidden;
      _viewer?.scene?.requestRender();
    },

    /** Prepared records from the last refresh (e.g. news zones). */
    getRecords() {
      return [..._records.values()];
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}
