import type { Position } from './types'

export const WEB_MERCATOR_LIMIT = 20_037_508.342789244
const EARTH_RADIUS_M = 6_371_008.8
const MAX_MERCATOR_LAT = 85.05112878

export function haversineMeters(a: Position, b: Position): number {
  const lat1 = radians(a.latitude)
  const lat2 = radians(b.latitude)
  const dLat = lat2 - lat1
  const dLon = radians(b.longitude - a.longitude)
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function lonLatToMercator(position: Position): { x: number; y: number } {
  const latitude = Math.min(MAX_MERCATOR_LAT, Math.max(-MAX_MERCATOR_LAT, position.latitude))
  return {
    x: (position.longitude * WEB_MERCATOR_LIMIT) / 180,
    y:
      Math.log(Math.tan(((90 + latitude) * Math.PI) / 360)) *
      (WEB_MERCATOR_LIMIT / Math.PI)
  }
}

export function mercatorToLonLat(x: number, y: number): Position {
  return {
    longitude: (x / WEB_MERCATOR_LIMIT) * 180,
    latitude: (Math.atan(Math.exp((y / WEB_MERCATOR_LIMIT) * Math.PI)) * 360) / Math.PI - 90
  }
}

export function cellForPosition(position: Position, cellMeters: number): { x: number; y: number } {
  const mercator = lonLatToMercator(position)
  return { x: Math.floor(mercator.x / cellMeters), y: Math.floor(mercator.y / cellMeters) }
}

export interface MercatorBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function tileMercatorBounds(z: number, x: number, y: number): MercatorBounds {
  const count = 2 ** z
  const span = (2 * WEB_MERCATOR_LIMIT) / count
  const minX = -WEB_MERCATOR_LIMIT + x * span
  const maxY = WEB_MERCATOR_LIMIT - y * span
  return { minX, minY: maxY - span, maxX: minX + span, maxY }
}

export function bboxToCellRange(
  bounds: MercatorBounds,
  cellMeters: number
): { minCellX: number; minCellY: number; maxCellX: number; maxCellY: number } {
  return {
    minCellX: Math.floor(bounds.minX / cellMeters),
    minCellY: Math.floor(bounds.minY / cellMeters),
    maxCellX: Math.floor(bounds.maxX / cellMeters),
    maxCellY: Math.floor(bounds.maxY / cellMeters)
  }
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180
}
