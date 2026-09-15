import { lonLatToMercator, tileMercatorBounds } from './geo'
import type { CsbSounding } from './noaa-csb'

const MVT_EXTENT = 4096
const CONTOUR_LEVELS_M = [2, 4, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200]

export interface CsbContour {
  ring: Array<{ x: number; y: number }>
  depth: number
  interpolationRadiusM: number
}

interface Sample {
  x: number
  y: number
  depth: number
}

/**
 * Derive deliberately low-confidence contours from nearby CSB observations.
 *
 * Crowdsourced bathymetry is usually a collection of vessel tracks rather than a complete surface.
 * A bounded inverse-distance grid gives useful regional shape without extrapolating far from an
 * observed track. The portrayal identifies these as approximate and never uses them as a safety
 * contour.
 */
export function observedContours(
  soundings: readonly CsbSounding[],
  z: number,
  x: number,
  y: number
): CsbContour[] {
  if (z < 7 || soundings.length < 2) return []

  const bounds = tileMercatorBounds(z, x, y)
  const span = bounds.maxX - bounds.minX
  const supportSteps = z === 7 ? 128 : z < 12 ? 64 : z >= 16 ? 32 : z >= 14 ? 24 : 16
  // Refine the drawn surface without shrinking the evidence neighborhood or extending coverage.
  const steps = Math.max(64, supportSteps)
  const cellMeters = span / supportSteps
  // At wide zoom the interpolation may bridge a modest gap in a survey line. At close zoom it
  // tightens with the map scale, and never invents a surface more than two grid cells from evidence.
  const radiusMeters = Math.min(cellMeters * 2, 3000)
  const levels = z < 12 ? [10, 20, 50, 100, 200, 500, 1000, 2000, 4000] : CONTOUR_LEVELS_M
  const bucketMeters = radiusMeters
  const samples: Sample[] = soundings.map((sounding) => {
    const point = lonLatToMercator(sounding)
    return { x: point.x, y: point.y, depth: sounding.depthM }
  })
  const buckets = new Map<string, Sample[]>()
  for (const sample of samples) {
    const key = bucketKey(sample.x, sample.y, bucketMeters)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(sample)
    else buckets.set(key, [sample])
  }

  const values: Array<number | undefined> = []
  for (let gy = 0; gy <= steps; gy += 1) {
    const sampleY = bounds.maxY - (gy / steps) * span
    for (let gx = 0; gx <= steps; gx += 1) {
      const sampleX = bounds.minX + (gx / steps) * span
      values.push(interpolatedDepth(sampleX, sampleY, radiusMeters, bucketMeters, buckets))
    }
  }

  const contours: CsbContour[] = []
  for (let gy = 0; gy < steps; gy += 1) {
    for (let gx = 0; gx < steps; gx += 1) {
      const corners = [
        gridValue(values, steps, gx, gy),
        gridValue(values, steps, gx + 1, gy),
        gridValue(values, steps, gx + 1, gy + 1),
        gridValue(values, steps, gx, gy + 1)
      ]
      if (corners.some((value) => value === undefined)) continue
      const depths = corners as number[]
      const minimum = Math.min(...depths)
      const maximum = Math.max(...depths)
      for (const depth of levels) {
        if (depth <= minimum || depth > maximum) continue
        const crossings = cellCrossings(gx, gy, steps, depths, depth)
        if (crossings.length === 2) {
          contours.push({ ring: crossings, depth, interpolationRadiusM: radiusMeters })
        } else if (crossings.length === 4) {
          // Resolve a saddle deterministically from the cell-center estimate. This retains two
          // short contour segments without joining diagonally unrelated shallow areas.
          const centerIsShallow = depths.reduce((sum, value) => sum + value, 0) / 4 < depth
          const pairs = centerIsShallow
            ? [[crossings[0]!, crossings[1]!], [crossings[2]!, crossings[3]!]]
            : [[crossings[0]!, crossings[3]!], [crossings[1]!, crossings[2]!]]
          for (const ring of pairs) contours.push({ ring, depth, interpolationRadiusM: radiusMeters })
        }
      }
    }
  }
  return contours
}

function bucketKey(x: number, y: number, bucketMeters: number): string {
  return `${Math.floor(x / bucketMeters)}:${Math.floor(y / bucketMeters)}`
}

function interpolatedDepth(
  x: number,
  y: number,
  radiusMeters: number,
  bucketMeters: number,
  buckets: ReadonlyMap<string, readonly Sample[]>
): number | undefined {
  const bucketX = Math.floor(x / bucketMeters)
  const bucketY = Math.floor(y / bucketMeters)
  const nearby: Array<{ distanceSquared: number; depth: number }> = []
  const radiusSquared = radiusMeters ** 2
  for (let by = bucketY - 1; by <= bucketY + 1; by += 1) {
    for (let bx = bucketX - 1; bx <= bucketX + 1; bx += 1) {
      for (const sample of buckets.get(`${bx}:${by}`) ?? []) {
        const distanceSquared = (sample.x - x) ** 2 + (sample.y - y) ** 2
        if (distanceSquared <= radiusSquared) nearby.push({ distanceSquared, depth: sample.depth })
      }
    }
  }
  if (nearby.length < 2) return undefined
  nearby.sort((a, b) => a.distanceSquared - b.distanceSquared)
  let weightedDepth = 0
  let totalWeight = 0
  for (const sample of nearby.slice(0, 8)) {
    if (sample.distanceSquared < 0.01) return sample.depth
    const weight = 1 / sample.distanceSquared
    weightedDepth += sample.depth * weight
    totalWeight += weight
  }
  return weightedDepth / totalWeight
}

function gridValue(
  values: readonly (number | undefined)[],
  steps: number,
  x: number,
  y: number
): number | undefined {
  return values[y * (steps + 1) + x]
}

function cellCrossings(
  gridX: number,
  gridY: number,
  steps: number,
  values: readonly number[],
  depth: number
): Array<{ x: number; y: number }> {
  const vertices = [
    { x: gridX, y: gridY },
    { x: gridX + 1, y: gridY },
    { x: gridX + 1, y: gridY + 1 },
    { x: gridX, y: gridY + 1 }
  ]
  const result: Array<{ x: number; y: number }> = []
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4
    const from = values[index]!
    const to = values[next]!
    if ((from < depth) === (to < depth) || from === to) continue
    const ratio = (depth - from) / (to - from)
    result.push({
      x: Math.round(
        ((vertices[index]!.x + ratio * (vertices[next]!.x - vertices[index]!.x)) / steps) *
          MVT_EXTENT
      ),
      y: Math.round(
        ((vertices[index]!.y + ratio * (vertices[next]!.y - vertices[index]!.y)) / steps) *
          MVT_EXTENT
      )
    })
  }
  return result
}
