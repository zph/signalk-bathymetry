import type { Path, history } from '@signalk/server-api'
import type { Position } from './types'
const TIDE_PATH = 'environment.tide.heightNow'
const SOG_PATH = 'navigation.speedOverGround'
const TIDE_MAX_RATE_M_PER_MIN = 0.05

export function spec(path: string, aggregate: history.PathSpec['aggregate']): history.PathSpec {
  return { path: path as Path, aggregate, parameter: [] }
}

/**
 * Produce the fixed row layout consumed by rowToSounding:
 * [timestamp, position, depth, tide, speed]. Each path is queried through its
 * own History API call and joined here by nearest timestamp, because multi-path
 * merges have been observed to concatenate per-path blocks with misaligned
 * columns. The tide series additionally passes a physical rate check: real
 * tides change at centimeters per minute, so a jump that implies a faster rate
 * than TIDE_MAX_RATE_M_PER_MIN is provider corruption and gets dropped from the
 * tail of the series (sustained ramps truncate the series the moment they begin).
 */
export function alignHistoryRows(
  positions: history.ValuesResponse,
  depth: history.ValuesResponse,
  tide: history.ValuesResponse,
  sog: history.ValuesResponse | undefined,
  toleranceMs: number,
  tideToleranceMs: number,
  depthPath: string,
  positionPath = 'navigation.position'
): unknown[][] {
  const positionSeries = seriesFor(positions, positionPath, isPositionValue)
  const depthSeries = seriesFor(depth, depthPath, isNumberValue)
  const tideSeries = plausibilityFilter(seriesFor(tide, TIDE_PATH, isNumberValue))
  const sogSeries = sog ? seriesFor(sog, SOG_PATH, isNumberValue) : []
  if (positionSeries.length === 0 || depthSeries.length === 0) return []

  const result: unknown[][] = []
  let positionIndex = 0
  for (const item of depthSeries) {
    while (
      positionIndex + 1 < positionSeries.length &&
      positionSeries[positionIndex + 1]!.atMs <= item.atMs
    ) {
      positionIndex += 1
    }
    const position = nearestWithin(positionSeries, item.atMs, toleranceMs)
    if (!position) continue
    const tide = nearestWithin(tideSeries, item.atMs, tideToleranceMs)
    if (!tide) continue
    const sog = nearestWithin(sogSeries, item.atMs, tideToleranceMs)
    result.push([
      new Date(item.atMs).toISOString(),
      position.value,
      item.value,
      tide.value,
      sog?.value
    ])
  }
  return result
}

export interface TimePoint {
  atMs: number
  value: unknown
}

export function seriesFor(
  response: history.ValuesResponse,
  path: string,
  isUsable: (value: unknown) => boolean
): TimePoint[] {
  const column = responseColumn(response, path)
  if (column < 1) return []
  return response.data
    .map((row) => ({ atMs: parseTimestamp(row[0]), value: row[column] }))
    .filter(
      (item): item is TimePoint => item.atMs !== undefined && isUsable(item.value)
    )
    .sort((a, b) => a.atMs - b.atMs)
}

export function isNumberValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isPositionValue(value: unknown): boolean {
  return (
    Array.isArray(value) ||
    (!!value && typeof value === 'object')
  )
}

/**
 * Drop tide samples that imply an impossible rate of change against the last
 * kept sample. Once corruption starts (a phantom jump or a compressed ramp),
 * every following sample is measured against the last honest one, so the
 * corrupt tail is truncated wholesale instead of poisoning soundings.
 */
export function plausibilityFilter(series: TimePoint[]): TimePoint[] {
  const kept: TimePoint[] = []
  let last: TimePoint | undefined
  for (const point of series) {
    if (last) {
      const minutes = (point.atMs - last.atMs) / 60_000
      if (minutes > 0) {
        const rate = Math.abs((point.value as number) - (last.value as number)) / minutes
        if (rate > TIDE_MAX_RATE_M_PER_MIN) continue
      }
    }
    kept.push(point)
    last = point
  }
  return kept
}

export function nearestWithin(
  series: TimePoint[],
  atMs: number,
  toleranceMs: number
): TimePoint | undefined {
  let low = 0
  let high = series.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (series[mid]!.atMs < atMs) low = mid + 1
    else high = mid
  }
  const before = series[low - 1]
  const after = series[low]
  const nearest =
    before && after
      ? atMs - before.atMs <= after.atMs - atMs
        ? before
        : after
      : (before ?? after)
  return nearest && Math.abs(nearest.atMs - atMs) <= toleranceMs ? nearest : undefined
}

function responseColumn(response: history.ValuesResponse, path: string): number {
  const index = response.values.findIndex((value) => value.path === path)
  return index < 0 ? -1 : index + 1
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parsePosition(value: unknown): Position | undefined {
  if (Array.isArray(value)) {
    const longitude = finite(value[0])
    const latitude = finite(value[1])
    if (latitude === undefined || longitude === undefined) return undefined
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined
    return { latitude, longitude }
  }
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { latitude?: unknown; longitude?: unknown }
  const latitude = finite(candidate.latitude)
  const longitude = finite(candidate.longitude)
  if (latitude === undefined || longitude === undefined) return undefined
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined
  return { latitude, longitude }
}
