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
  return hexCellForMercator(mercator.x, mercator.y, cellMeters)
}

/** Pointy-top axial hex coordinates. cellMeters is the flat-to-flat width. */
export function hexCellForMercator(
  mercatorX: number,
  mercatorY: number,
  cellMeters: number
): { x: number; y: number } {
  const fractionalX = mercatorX / cellMeters - mercatorY / (Math.sqrt(3) * cellMeters)
  const fractionalY = (2 * mercatorY) / (Math.sqrt(3) * cellMeters)
  return roundAxial(fractionalX, fractionalY)
}

export function hexCellCenter(
  cellX: number,
  cellY: number,
  cellMeters: number
): { x: number; y: number } {
  return {
    x: cellMeters * (cellX + cellY / 2),
    y: cellMeters * (Math.sqrt(3) / 2) * cellY
  }
}

export function hexCellVertices(
  cellX: number,
  cellY: number,
  cellMeters: number
): Array<{ x: number; y: number }> {
  const center = hexCellCenter(cellX, cellY, cellMeters)
  const radius = cellMeters / Math.sqrt(3)
  return Array.from({ length: 6 }, (_, index) => {
    const angle = ((30 + index * 60) * Math.PI) / 180
    return {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle)
    }
  })
}

export function hexCellMercatorBounds(
  cellX: number,
  cellY: number,
  cellMeters: number
): MercatorBounds {
  const vertices = hexCellVertices(cellX, cellY, cellMeters)
  return {
    minX: Math.min(...vertices.map((point) => point.x)),
    minY: Math.min(...vertices.map((point) => point.y)),
    maxX: Math.max(...vertices.map((point) => point.x)),
    maxY: Math.max(...vertices.map((point) => point.y))
  }
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
  const corners = [
    fractionalAxial(bounds.minX, bounds.minY, cellMeters),
    fractionalAxial(bounds.minX, bounds.maxY, cellMeters),
    fractionalAxial(bounds.maxX, bounds.minY, cellMeters),
    fractionalAxial(bounds.maxX, bounds.maxY, cellMeters)
  ]
  return {
    minCellX: Math.floor(Math.min(...corners.map((point) => point.x))) - 2,
    minCellY: Math.floor(Math.min(...corners.map((point) => point.y))) - 2,
    maxCellX: Math.ceil(Math.max(...corners.map((point) => point.x))) + 2,
    maxCellY: Math.ceil(Math.max(...corners.map((point) => point.y))) + 2
  }
}

function fractionalAxial(
  mercatorX: number,
  mercatorY: number,
  cellMeters: number
): { x: number; y: number } {
  return {
    x: mercatorX / cellMeters - mercatorY / (Math.sqrt(3) * cellMeters),
    y: (2 * mercatorY) / (Math.sqrt(3) * cellMeters)
  }
}

function roundAxial(x: number, y: number): { x: number; y: number } {
  const cubeX = x
  const cubeZ = y
  const cubeY = -cubeX - cubeZ
  let roundedX = Math.round(cubeX)
  let roundedY = Math.round(cubeY)
  let roundedZ = Math.round(cubeZ)
  const xDifference = Math.abs(roundedX - cubeX)
  const yDifference = Math.abs(roundedY - cubeY)
  const zDifference = Math.abs(roundedZ - cubeZ)
  if (xDifference > yDifference && xDifference > zDifference) roundedX = -roundedY - roundedZ
  else if (yDifference > zDifference) roundedY = -roundedX - roundedZ
  else roundedZ = -roundedX - roundedY
  return { x: roundedX, y: roundedZ }
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180
}
