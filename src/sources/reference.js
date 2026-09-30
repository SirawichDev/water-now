import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import {
  createBkkWaterSource,
  createBkkOutageSource,
  createBkkNewsSource,
  createBkkCamsSource,
} from '../layers/bkk/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    cables: createBundledCableSource(),
    'bkk-water': createBkkWaterSource(),
    'bkk-outages': createBkkOutageSource(),
    'bkk-news': createBkkNewsSource(),
    'bkk-cams': createBkkCamsSource(),
  };
}
