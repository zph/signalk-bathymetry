import { Temporal } from '@js-temporal/polyfill'
import type { Context, Path, ServerAPI, history } from '@signalk/server-api'
import { depthReferenceFromPath } from './config'
import { aggregateStationaryWindow } from './stationary'
import type { CaptureEngine } from './capture'
import type { BathymetryConfig, Position, SoundingInput } from './types'

const MAX_RANGE_MS = 31 * 86_400_000
const CHUNK_MS = 6 * 3_600_000
const TIDE_PATH = 'environment.tide.heightNow'
const SOG_PATH = 'navigation.speedOverGround'

/**
 * A tide series cannot physically change faster than this (m per minute). The
 * steepest real tides on Earth (Bay of Fundy) average just under 0.05 m/min;
 * Carquinez runs closer to 0.02. The observed provider corruption implied
 * 0.066-23 m/min.
 */
const TIDE_MAX_RATE_M_PER_MIN = 0.05

export class HistoryBackfill {
  private running = false
  private stationaryWindow: SoundingInput[] = []
  private stationarySequence = 0

  constructor(
    private readonly app: ServerAPI,
    private readonly capture: CaptureEngine,
    private readonly config: BathymetryConfig
  ) {}

  isRunning(): boolean {
    return this.running
  }

  async run(fromMs: number, toMs: number): Promise<{ rows: number; chunks: number }> {
    if (this.running) throw new Error('A history backfill is already running')
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      throw new Error('Backfill requires a valid from time before to time')
    }
    if (toMs - fromMs > MAX_RANGE_MS) {
      throw new Error('One backfill request is limited to 31 days')
    }
    if (!this.app.getHistoryApi) throw new Error('This Signal K server does not expose History API access')
    this.running = true
    this.stationarySequence = 0
    let rows = 0
    let chunks = 0
    try {
      const history = await this.app.getHistoryApi(this.config.historyProvider)
      for (let cursor = fromMs; cursor < toMs; cursor += CHUNK_MS) {
        const chunkEnd = Math.min(toMs, cursor + CHUNK_MS)
        const request = {
          from: Temporal.Instant.fromEpochMilliseconds(cursor),
          to: Temporal.Instant.fromEpochMilliseconds(chunkEnd),
          context: 'vessels.self' as Context,
          resolution: this.config.historyResolutionSeconds
        }
        // Some providers query position and numeric paths through separate
        // internal pipelines, then incorrectly require equal row counts. Query
        // them independently and join their sparse buckets by timestamp.
        // The tide path suffers the same disease at fine resolutions: multi-path
        // merges have been observed to concatenate per-path blocks with
        // misaligned columns, producing phantom tide jumps and silent gaps even
        // when the provider stores a clean one-minute tide series. Query each
        // path independently (the tide and SOG at a minimum of 60 s, because they
        // change slowly and are recorded sparsely) and join by timestamp.
        const [positions, depth, tide, sog] = await Promise.all([
          history.getValues({ ...request, pathSpecs: [spec(this.config.positionPath, 'first')] }),
          history.getValues({
            ...request,
            pathSpecs: [spec(this.config.depthPath, 'average')]
          }),
          history.getValues({
            ...request,
            resolution: Math.max(60, this.config.historyResolutionSeconds),
            pathSpecs: [spec(TIDE_PATH, 'average')]
          }),
          history.getValues({
            ...request,
            resolution: Math.max(60, this.config.historyResolutionSeconds),
            pathSpecs: [spec(SOG_PATH, 'average')]
          })
        ])
        const alignedRows = alignHistoryRows(
          positions,
          depth,
          tide,
          sog,
          Math.max(5_000, this.config.historyResolutionSeconds * 2_000),
          Math.max(180_000, this.config.historyResolutionSeconds * 2_000),
          this.config.depthPath,
          this.config.positionPath
        )
        for (const row of alignedRows) {
          const sounding = this.rowToSounding(row)
          if (!sounding) continue
          this.routeSounding(sounding)
          rows += 1
        }
        this.capture.flush()
        chunks += 1
      }
      this.finishStationaryWindow()
      this.capture.flush()
      return { rows, chunks }
    } finally {
      this.stationaryWindow = []
      this.running = false
    }
  }

  private routeSounding(sounding: SoundingInput): void {
    if (sounding.sogMps !== undefined && sounding.sogMps < this.config.minSpeedMps) {
      this.stationaryWindow.push(sounding)
      const first = this.stationaryWindow[0]
      if (
        first &&
        sounding.observedAtMs - first.observedAtMs >= this.config.stationaryWindowSeconds * 1000
      ) {
        this.finishStationaryWindow()
      }
      return
    }
    this.finishStationaryWindow()
    this.capture.enqueueHistorical(sounding)
  }

  private finishStationaryWindow(): void {
    const samples = this.stationaryWindow
    this.stationaryWindow = []
    const first = samples[0]
    if (!first) return
    this.stationarySequence += 1
    const aggregate = aggregateStationaryWindow(
      samples,
      this.config,
      `${first.trackId}-visit-${this.stationarySequence}`
    )
    if (aggregate) this.capture.enqueueHistorical(aggregate)
  }

  private rowToSounding(row: readonly unknown[]): SoundingInput | undefined {
    const timestamp = row[0]
    const position = parsePosition(row[1])
    const rawDepthM = finite(row[2])
    const tideHeightM = finite(row[3])
    const sogMps = finite(row[4])
    if (typeof timestamp !== 'string' || !position || rawDepthM === undefined || tideHeightM === undefined) {
      return undefined
    }
    const observedAtMs = Date.parse(timestamp)
    if (!Number.isFinite(observedAtMs)) return undefined
    if (rawDepthM < this.config.instrumentMinM || rawDepthM > this.config.instrumentMaxM) return undefined
    const reference = depthReferenceFromPath(this.config.depthPath)
    const offsetM =
      reference === 'belowKeel'
        ? this.config.surfaceToKeelM
        : reference === 'belowTransducer'
          ? this.config.surfaceToTransducerM
          : 0
    const datumDepthM = rawDepthM + offsetM - tideHeightM
    const verticalSigmaM = Math.sqrt(
      this.config.depthSigmaM ** 2 +
        this.config.offsetSigmaM ** 2 +
        this.config.tideSigmaM ** 2 +
        0.15 ** 2
    )
    const date = new Date(observedAtMs).toISOString().slice(0, 10)
    const sounding: SoundingInput = {
      observedAtMs,
      ingestedAtMs: Date.now(),
      origin: 'history',
      context: 'vessels.self',
      trackId: `history-${date}`,
      passId: `history-${date}`,
      latitude: position.latitude,
      longitude: position.longitude,
      positionSource: 'history:unknown',
      rawDepthM,
      depthReference: reference,
      depthSource: 'history:unknown',
      tideHeightM,
      tideDatum: this.config.targetDatum,
      tideStationId: this.config.tideStationId,
      tideStationName: this.config.tideStationName,
      tideMethod: 'unknown',
      tideSource: 'history:unknown',
      tideObservedAtMs: observedAtMs,
      datumDepthM,
      verticalSigmaM,
      inputTimeSkewMs: this.config.historyResolutionSeconds * 1000
    }
    if (reference === 'belowKeel') sounding.surfaceToKeelM = this.config.surfaceToKeelM
    if (reference === 'belowTransducer') {
      sounding.surfaceToTransducerM = this.config.surfaceToTransducerM
    }
    if (sogMps !== undefined) sounding.sogMps = sogMps
    return sounding
  }
}

function spec(path: string, aggregate: history.PathSpec['aggregate']): history.PathSpec {
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

interface TimePoint {
  atMs: number
  value: unknown
}

function seriesFor(
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

function isNumberValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPositionValue(value: unknown): boolean {
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
function plausibilityFilter(series: TimePoint[]): TimePoint[] {
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

function nearestWithin(
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

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parsePosition(value: unknown): Position | undefined {
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
