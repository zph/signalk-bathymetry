import { lonLatToMercator, mercatorToLonLat, tileMercatorBounds } from './geo'
import type { CsbSounding, NoaaCsbStore } from './noaa-csb'
import { encodeSoundingPointTile, encodeDepthContourTile, encodeTrackLineTile } from './vector-tiles'
import { observedContours } from './noaa-csb-contours'
import { WaterBoundary } from './csb-water-mask'
import { assessCsbSoundings, type AssessedSounding } from './noaa-csb-quality'

const MVT_EXTENT = 4096
const EARTH_CIRCUMFERENCE_M = 40_075_016.686
const MIN_DISPLAY_CELL_M = 5
const MAX_QUERY_SOUNDINGS = 100_000
const MAX_TRACK_VERTICES = 6_000

export const NOAA_CSB_MVT_REVISION = 'csb-water-quality2'

export interface RenderedCsbTile {
  tile: Buffer
  soundingCount: number
  pointCount: number
  cellMeters: number
}

interface Aggregate {
  samples: AssessedSounding[]
  x: number
  y: number
}

export class NoaaCsbTileRenderer {
  constructor(
    private readonly store: NoaaCsbStore,
    private readonly minZoom = 7,
    private readonly maxZoom = 24,
    private readonly tides?: import('./csb-tides').CsbTides
  ) {}

  render(z: number, x: number, y: number, archiveSoundings?: CsbSounding[], waterMask?: unknown): RenderedCsbTile {
    const water = WaterBoundary.parse(waterMask, z, x, y)
    const cellMeters = Math.max(
      MIN_DISPLAY_CELL_M,
      (EARTH_CIRCUMFERENCE_M / 2 ** z / 256) * 16
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
    const rawSoundings = archiveSoundings ?? this.store.listSoundings(
      [southwest.longitude, southwest.latitude, northeast.longitude, northeast.latitude],
      MAX_QUERY_SOUNDINGS
    )
    const soundings = this.tides?.apply(rawSoundings) ?? rawSoundings
    const corrected = soundings.filter(s => s.tidalCorrection?.status === 'estimated')
    const raw = soundings.filter(s => s.tidalCorrection?.status !== 'estimated')
    const assessed = [...assessCsbSoundings(raw), ...assessCsbSoundings(corrected)]
    const aggregates = aggregateSoundings(assessed, cellMeters)
    const span = bounds.maxX - bounds.minX
    const features = aggregates.map((aggregate) => {
      const depths = aggregate.samples.map((sample) => sample.depthM).sort((a, b) => a - b)
      const supported = aggregate.samples.filter(s => s.contourEligible)
      const candidates = supported.length ? supported : aggregate.samples
      const representative = candidates.reduce((a,b) => a.depthM <= b.depthM ? a : b)
      const depthM = representative.depthM
      const position = lonLatToMercator(representative)
      return {
        point: {
          x: Math.round(((position.x - bounds.minX) / span) * MVT_EXTENT),
          y: Math.round(((bounds.maxY - position.y) / span) * MVT_EXTENT)
        },
        properties: {
          // S-57 clients label DEPTH/VALSOU directly, ignoring BATHY_LABEL.
          // Keep disputed values inspectable without emitting a normal sounding label.
          ...(representative.contourEligible ? { DEPTH: depthM, VALSOU: depthM } : {}),
          BATHYMETRY_PROVIDER: 'noaa-csb',
          BATHY_DATUM: representative.tidalCorrection?.status === 'estimated' ? 'MLLW_ESTIMATE' : 'UNKNOWN',
          CSB_TIDE_STATUS: representative.tidalCorrection?.status ?? 'off',
          ...(representative.tidalCorrection?.status === 'estimated' ? {
            CSB_ORIGINAL_DEPTH_M: representative.tidalCorrection.originalDepthM,
            CSB_TIDE_WATER_LEVEL_M: representative.tidalCorrection.waterLevelM!,
            CSB_SENSOR_OFFSET_M: representative.tidalCorrection.sensorOffsetM!,
            CSB_TIDE_STATION: representative.tidalCorrection.stationId!,
            CSB_TIDE_SOURCE: representative.tidalCorrection.sourceUrl!,
            CSB_TIDE_FETCHED_AT_MS: representative.tidalCorrection.fetchedAtMs!,
            CSB_TIDE_METHOD: representative.tidalCorrection.method!
          } : {}),
          BATHY_DEPTH_M: depthM,
          BATHY_LABEL: representative.contourEligible ? (depthM >= 10 ? Math.floor(depthM).toFixed(0) : depthM.toFixed(1)) : '?',
          BATHY_LABEL_UNIT: 'm',
          BATHY_CONFIDENCE: representative.reliability,
          BATHY_CONFIDENCE_REASONS: representative.qualityReasons.join('|'),
          CSB_QUALITY_METHOD: 'observed-consistency-v1',
          CSB_CONTOUR_ELIGIBLE: representative.contourEligible,
          CSB_SUSPECT_COUNT: aggregate.samples.filter(s => !s.contourEligible).length,
          CSB_RAW_MIN_DEPTH_M: aggregate.samples.reduce((n,s) => Math.min(n, s.tidalCorrection?.originalDepthM ?? s.minDepthM ?? s.depthM), Infinity),
          CSB_RAW_MAX_DEPTH_M: aggregate.samples.reduce((n,s) => Math.max(n, s.tidalCorrection?.originalDepthM ?? s.maxDepthM ?? s.depthM), -Infinity),
          ...(representative.sourceOffsetM === undefined ? {} : { CSB_ESTIMATED_OFFSET_M: representative.sourceOffsetM }),
          BATHY_SOUNDING_COUNT: aggregate.samples.reduce((n,s) => n + (s.sampleCount ?? 1),0),
          CSB_MIN_DEPTH_M: depths[0]!,
          CSB_MAX_DEPTH_M: aggregate.samples.reduce((n,s) => Math.max(n,s.maxDepthM ?? s.depthM),depthM),
          CSB_OBSERVED_AT_MS: representative.observedAtMs,
          CSB_PLATFORM: representative.platform,
          CSB_PROVIDER: representative.provider,
          CSB_INSTRUMENT: representative.instrument,
          CSB_DEPTH_REFERENCE: representative.tidalCorrection?.status === 'estimated' ? 'estimated-MLLW-station-transfer' : 'raw-observed-datum-unknown',
          CSB_NOT_FOR_NAVIGATION: true
        }
      }
    })
    return {
      tile: Buffer.concat([encodeSoundingPointTile(features),
        encodeTrackLineTile(buildTrackLines(soundings, bounds, z)),
        // Do not mix datums in interpolation. Corrected observations remain labeled points;
        // an estimated contour could conceal adjacent unsupported raw measurements.
        encodeDepthContourTile(observedContours(assessed.filter(s => s.contourEligible && s.tidalCorrection?.status !== 'estimated'),z,x,y,water))]),
      soundingCount: soundings.length,
      pointCount: features.length,
      cellMeters
    }
  }
}

export function buildTrackLines(
  soundings: readonly CsbSounding[],
  bounds: ReturnType<typeof tileMercatorBounds>,
  zoom: number
) {
  const span = bounds.maxX - bounds.minX
  const journeys = new Map<string, CsbSounding[]>()
  for (const sounding of soundings) {
    // An archive aggregate can represent multiple source files. Never connect those unrelated
    // cells into an invented journey line merely because their identity was intentionally blanked.
    if (!sounding.uniqueId || !sounding.fileUuid) continue
    const key = `${sounding.uniqueId}\u0000${sounding.fileUuid}`
    const journey = journeys.get(key)
    if (journey) journey.push(sounding)
    else journeys.set(key, [sounding])
  }
  const features: Array<{
    properties: Record<string, string | number | boolean>
    line: Array<{ x: number; y: number }>
  }> = []
  const baseScreenStep = zoom <= 14 ? 4 : zoom <= 16 ? 3 : 2
  const densityScale = Math.max(1, Math.sqrt(soundings.length / MAX_TRACK_VERTICES))
  const minimumStep = (MVT_EXTENT / 256) * baseScreenStep * densityScale
  const flush = (line: Array<{ x: number; y: number }>) => {
    if (line.length >= 2) features.push({ properties: { CSB_NOT_FOR_NAVIGATION: true }, line })
  }
  for (const journey of journeys.values()) {
    journey.sort((left, right) => left.observedAtMs - right.observedAtMs)
    let line: Array<{ x: number; y: number }> = []
    let lastSeen: { x: number; y: number } | undefined
    let previousTime: number | undefined
    const finishLine = () => {
      const previous = line.at(-1)
      if (lastSeen && previous && (lastSeen.x !== previous.x || lastSeen.y !== previous.y)) {
        line.push(lastSeen)
      }
      flush(line)
      line = []
      lastSeen = undefined
    }
    for (const sounding of journey) {
      if (previousTime !== undefined && sounding.observedAtMs - previousTime > 5 * 60_000) {
        finishLine()
      }
      const mercator = lonLatToMercator(sounding)
      const point = {
        x: Math.round(((mercator.x - bounds.minX) / span) * MVT_EXTENT),
        y: Math.round(((bounds.maxY - mercator.y) / span) * MVT_EXTENT)
      }
      const previous = line.at(-1)
      if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= minimumStep) {
        line.push(point)
      }
      lastSeen = point
      previousTime = sounding.observedAtMs
    }
    finishLine()
  }
  return limitTrackVertices(features)
}

function limitTrackVertices<T extends { line: Array<{ x: number; y: number }> }>(features: T[]): T[] {
  const total = features.reduce((sum, feature) => sum + feature.line.length, 0)
  if (total <= MAX_TRACK_VERTICES) return features
  const stride = Math.ceil(total / MAX_TRACK_VERTICES)
  const simplified = features.map((feature) => {
    if (feature.line.length <= 2) return feature
    const line = feature.line.filter((_, index) => index === 0 || index % stride === 0)
    const last = feature.line.at(-1)!
    if (line.at(-1) !== last) line.push(last)
    return { ...feature, line }
  })
  if (simplified.reduce((sum, feature) => sum + feature.line.length, 0) <= MAX_TRACK_VERTICES) {
    return simplified
  }
  // A pathological tile can contain thousands of two-point journeys that cannot be simplified.
  // Retain the longest visible journeys first instead of sending an unbounded tile to the GPU.
  return simplified
    .map((feature) => ({ feature, length: lineLength(feature.line) }))
    .sort((left, right) => right.length - left.length)
    .reduce<{ features: T[]; vertices: number }>((result, entry) => {
      if (result.vertices + entry.feature.line.length <= MAX_TRACK_VERTICES) {
        result.features.push(entry.feature)
        result.vertices += entry.feature.line.length
      }
      return result
    }, { features: [], vertices: 0 }).features
}

function lineLength(line: Array<{ x: number; y: number }>): number {
  let length = 0
  for (let index = 1; index < line.length; index += 1) {
    const previous = line[index - 1]!
    const point = line[index]!
    length += Math.hypot(point.x - previous.x, point.y - previous.y)
  }
  return length
}

function aggregateSoundings(soundings: readonly AssessedSounding[], cellMeters: number): Aggregate[] {
  const cells = new Map<string, Aggregate>()
  for (const sounding of soundings) {
    const point = lonLatToMercator(sounding)
    const key = `${sounding.tidalCorrection?.status === 'estimated' ? 'MLLW' : 'raw'}:${Math.floor(point.x / cellMeters)}:${Math.floor(point.y / cellMeters)}`
    const aggregate = cells.get(key)
    if (aggregate) {
      aggregate.samples.push(sounding)
      aggregate.x += (point.x - aggregate.x) / aggregate.samples.length
      aggregate.y += (point.y - aggregate.y) / aggregate.samples.length
    } else cells.set(key, { samples: [sounding], x: point.x, y: point.y })
  }
  return [...cells.values()]
}
