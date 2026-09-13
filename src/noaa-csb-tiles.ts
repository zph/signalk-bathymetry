import { lonLatToMercator, mercatorToLonLat, tileMercatorBounds } from './geo'
import type { CsbSounding, NoaaCsbStore } from './noaa-csb'
import { encodeSoundingPointTile } from './vector-tiles'

const MVT_EXTENT = 4096
const EARTH_CIRCUMFERENCE_M = 40_075_016.686
const MIN_DISPLAY_CELL_M = 5
const MAX_QUERY_SOUNDINGS = 100_000

export const NOAA_CSB_MVT_REVISION = 'csb-mvt1'

export interface RenderedCsbTile {
  tile: Buffer
  soundingCount: number
  pointCount: number
  cellMeters: number
}

interface Aggregate {
  samples: CsbSounding[]
  x: number
  y: number
}

export class NoaaCsbTileRenderer {
  constructor(
    private readonly store: NoaaCsbStore,
    private readonly minZoom = 8,
    private readonly maxZoom = 24
  ) {}

  render(z: number, x: number, y: number): RenderedCsbTile {
    const cellMeters = Math.max(
      MIN_DISPLAY_CELL_M,
      (EARTH_CIRCUMFERENCE_M / 2 ** z / 256) * 2
    )
    if (z < this.minZoom || z > this.maxZoom) {
      return {
        tile: encodeSoundingPointTile([]),
        soundingCount: 0,
        pointCount: 0,
        cellMeters
      }
    }
    const bounds = tileMercatorBounds(z, x, y)
    const southwest = mercatorToLonLat(bounds.minX, bounds.minY)
    const northeast = mercatorToLonLat(bounds.maxX, bounds.maxY)
    const soundings = this.store.listSoundings(
      [southwest.longitude, southwest.latitude, northeast.longitude, northeast.latitude],
      MAX_QUERY_SOUNDINGS
    )
    const aggregates = aggregateSoundings(soundings, cellMeters)
    const span = bounds.maxX - bounds.minX
    const features = aggregates.map((aggregate) => {
      const depths = aggregate.samples.map((sample) => sample.depthM).sort((a, b) => a - b)
      const representative = aggregate.samples[Math.floor(aggregate.samples.length / 2)]!
      const depthM = median(depths)
      return {
        point: {
          x: Math.round(((aggregate.x - bounds.minX) / span) * MVT_EXTENT),
          y: Math.round(((bounds.maxY - aggregate.y) / span) * MVT_EXTENT)
        },
        properties: {
          DEPTH: depthM,
          VALSOU: depthM,
          BATHYMETRY_PROVIDER: 'noaa-csb',
          BATHY_DATUM: 'UNKNOWN',
          BATHY_DEPTH_M: depthM,
          BATHY_LABEL: depthM >= 10 ? Math.floor(depthM).toFixed(0) : depthM.toFixed(1),
          BATHY_LABEL_UNIT: 'm',
          BATHY_CONFIDENCE: 0.2,
          BATHY_SOUNDING_COUNT: aggregate.samples.length,
          CSB_MIN_DEPTH_M: depths[0]!,
          CSB_MAX_DEPTH_M: depths[depths.length - 1]!,
          CSB_OBSERVED_AT_MS: representative.observedAtMs,
          CSB_PLATFORM: representative.platform,
          CSB_PROVIDER: representative.provider,
          CSB_INSTRUMENT: representative.instrument,
          CSB_DEPTH_REFERENCE: 'raw-observed-datum-unknown',
          CSB_NOT_FOR_NAVIGATION: true
        }
      }
    })
    return {
      tile: encodeSoundingPointTile(features),
      soundingCount: soundings.length,
      pointCount: features.length,
      cellMeters
    }
  }
}

function aggregateSoundings(soundings: readonly CsbSounding[], cellMeters: number): Aggregate[] {
  const cells = new Map<string, Aggregate>()
  for (const sounding of soundings) {
    const point = lonLatToMercator(sounding)
    const key = `${Math.floor(point.x / cellMeters)}:${Math.floor(point.y / cellMeters)}`
    const aggregate = cells.get(key)
    if (aggregate) {
      aggregate.samples.push(sounding)
      aggregate.x += (point.x - aggregate.x) / aggregate.samples.length
      aggregate.y += (point.y - aggregate.y) / aggregate.samples.length
    } else cells.set(key, { samples: [sounding], x: point.x, y: point.y })
  }
  return [...cells.values()]
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]!
  return (sorted[middle - 1]! + sorted[middle]!) / 2
}
