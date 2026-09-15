import { lonLatToMercator, mercatorToLonLat, tileMercatorBounds } from './geo'
import { encodeTrackLineTile, type VectorLineFeature } from './vector-tiles'

const MVT_EXTENT = 4096
const TILE_BUFFER = 64
const MAX_ROUTES = 500
// Tile-local tolerances shrink as native tiles get closer to the observations.
export function nauticalLaneDetail(zoom: number) {
  const levels = [
    { grid: 256, tolerance: 24, vertices: 6_000 },
    { grid: 512, tolerance: 16, vertices: 8_000 },
    { grid: 1024, tolerance: 8, vertices: 12_000 },
    { grid: 2048, tolerance: 4, vertices: 16_000 }
  ]
  if (!Number.isInteger(zoom) || zoom < 10 || zoom > 13) {
    throw new Error('NOAA generalized vectors require zoom 10 through 13')
  }
  return levels[zoom - 10]!
}
const NOAA_LINES = 'https://gis.ngdc.noaa.gov/arcgis/rest/services/csb/MapServer/1/query'

export const NOAA_CSB_LANES_VECTOR_REVISION = 'nautical-lanes-vector-v2'

interface QuantizedTrackResponse {
  error?: { message?: string }
  transform?: {
    originPosition?: string
    scale?: [number, number]
    translate?: [number, number]
  }
  features?: Array<{
    attributes?: { OBJECTID?: number }
    geometry?: { paths?: number[][][] }
  }>
}

/** Ask NOAA for a bounded sample of already-generalized journey vectors, not sounding points. */
export function nauticalLaneVectorUrl(z: number, x: number, y: number): string {
  const detail = nauticalLaneDetail(z)
  const mercator = tileMercatorBounds(z, x, y)
  const southwest = mercatorToLonLat(mercator.minX, mercator.minY)
  const northeast = mercatorToLonLat(mercator.maxX, mercator.maxY)
  const bounds: [number, number, number, number] = [
    southwest.longitude,
    southwest.latitude,
    northeast.longitude,
    northeast.latitude
  ]
  const tolerance = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) / detail.grid
  const query = new URLSearchParams({
    f: 'json',
    where: '1=1',
    geometry: bounds.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID,Shape_Length',
    orderByFields: 'Shape_Length DESC,OBJECTID ASC',
    returnGeometry: 'true',
    resultOffset: '0',
    resultRecordCount: String(MAX_ROUTES),
    quantizationParameters: JSON.stringify({
      mode: 'view',
      originPosition: 'upperLeft',
      tolerance,
      extent: {
        xmin: bounds[0],
        ymin: bounds[1],
        xmax: bounds[2],
        ymax: bounds[3],
        spatialReference: { wkid: 4326 }
      }
    })
  })
  return `${NOAA_LINES}?${query}`
}

export function encodeNauticalLaneVectors(
  response: QuantizedTrackResponse,
  z: number,
  x: number,
  y: number
): Buffer {
  const detail = nauticalLaneDetail(z)
  if (response.error) throw new Error(response.error.message || 'NOAA vector query failed')
  const transform = response.transform
  if (!transform?.scale || !transform.translate || transform.originPosition !== 'upperLeft') {
    throw new Error('NOAA vector query returned an unsupported coordinate transform')
  }
  const tileBounds = tileMercatorBounds(z, x, y)
  const span = tileBounds.maxX - tileBounds.minX
  const features: VectorLineFeature[] = []
  for (const feature of response.features ?? []) {
    for (const path of feature.geometry?.paths ?? []) {
      const line = decodePath(path, transform.scale, transform.translate).map((position) => {
        const mercator = lonLatToMercator(position)
        return {
          x: ((mercator.x - tileBounds.minX) / span) * MVT_EXTENT,
          y: ((tileBounds.maxY - mercator.y) / span) * MVT_EXTENT
        }
      })
      for (const clipped of clipLine(line)) {
        features.push({
          properties: {
            OBJECTID: feature.attributes?.OBJECTID ?? 0,
            CSB_GENERALIZED: true,
            CSB_NOT_FOR_NAVIGATION: true
          },
          line: simplifyLine(clipped, detail.tolerance)
        })
      }
    }
  }
  return encodeTrackLineTile(limitVertices(features, detail.vertices))
}

function decodePath(
  path: number[][],
  scale: [number, number],
  translate: [number, number]
): Array<{ longitude: number; latitude: number }> {
  let x = 0
  let y = 0
  return path.map((coordinate, index) => {
    if (index === 0) {
      x = coordinate[0] ?? 0
      y = coordinate[1] ?? 0
    } else {
      x += coordinate[0] ?? 0
      y += coordinate[1] ?? 0
    }
    return {
      longitude: translate[0] + x * scale[0],
      latitude: translate[1] - y * scale[1]
    }
  })
}

function clipLine(line: Array<{ x: number; y: number }>): Array<Array<{ x: number; y: number }>> {
  const result: Array<Array<{ x: number; y: number }>> = []
  let current: Array<{ x: number; y: number }> = []
  const flush = () => {
    if (current.length >= 2) result.push(current)
    current = []
  }
  for (let index = 1; index < line.length; index += 1) {
    const clipped = clipSegment(line[index - 1]!, line[index]!)
    if (!clipped) {
      flush()
      continue
    }
    const [start, end] = clipped
    const previous = current.at(-1)
    if (!previous || Math.abs(previous.x - start.x) > 0.5 || Math.abs(previous.y - start.y) > 0.5) {
      flush()
      current.push(roundPoint(start))
    }
    current.push(roundPoint(end))
  }
  flush()
  return result
}

function clipSegment(
  start: { x: number; y: number },
  end: { x: number; y: number }
): [{ x: number; y: number }, { x: number; y: number }] | undefined {
  const min = -TILE_BUFFER
  const max = MVT_EXTENT + TILE_BUFFER
  const dx = end.x - start.x
  const dy = end.y - start.y
  let lower = 0
  let upper = 1
  const edges: Array<[number, number]> = [
    [-dx, start.x - min],
    [dx, max - start.x],
    [-dy, start.y - min],
    [dy, max - start.y]
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return undefined
      continue
    }
    const ratio = q / p
    if (p < 0) lower = Math.max(lower, ratio)
    else upper = Math.min(upper, ratio)
    if (lower > upper) return undefined
  }
  return [
    { x: start.x + lower * dx, y: start.y + lower * dy },
    { x: start.x + upper * dx, y: start.y + upper * dy }
  ]
}

// Douglas-Peucker preserves bends by bounding perpendicular error, rather than
// discarding a bend simply because it is close to the preceding retained point.
export function simplifyLine(
  line: Array<{ x: number; y: number }>,
  tolerance: number
): Array<{ x: number; y: number }> {
  if (line.length <= 2) return line
  const keep = new Set([0, line.length - 1])
  const pending: Array<[number, number]> = [[0, line.length - 1]]
  while (pending.length) {
    const [first, last] = pending.pop()!
    const start = line[first]!
    const end = line[last]!
    const dx = end.x - start.x
    const dy = end.y - start.y
    const lengthSquared = dx * dx + dy * dy
    let greatest = tolerance * tolerance
    let selected = -1
    for (let index = first + 1; index < last; index++) {
      const point = line[index]!
      const fraction = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
        ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
      const error = (point.x - start.x - fraction * dx) ** 2 +
        (point.y - start.y - fraction * dy) ** 2
      if (error > greatest) {
        greatest = error
        selected = index
      }
    }
    if (selected !== -1) {
      keep.add(selected)
      pending.push([first, selected], [selected, last])
    }
  }
  return [...keep].sort((a, b) => a - b).map((index) => line[index]!)
}

function limitVertices(features: VectorLineFeature[], maxVertices: number): VectorLineFeature[] {
  return features
    .filter((feature) => feature.line.length >= 2)
    .map((feature) => ({ feature, length: lineLength(feature.line) }))
    .sort((left, right) => right.length - left.length)
    .reduce<{ features: VectorLineFeature[]; vertices: number }>((result, entry) => {
      if (result.vertices + entry.feature.line.length <= maxVertices) {
        result.features.push(entry.feature)
        result.vertices += entry.feature.line.length
      }
      return result
    }, { features: [], vertices: 0 }).features
}

function lineLength(line: Array<{ x: number; y: number }>): number {
  let length = 0
  for (let index = 1; index < line.length; index += 1) {
    length += Math.hypot(line[index]!.x - line[index - 1]!.x, line[index]!.y - line[index - 1]!.y)
  }
  return length
}

function roundPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(point.x), y: Math.round(point.y) }
}
