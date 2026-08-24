import { Temporal } from '@js-temporal/polyfill'
import type { Context, Path, ServerAPI, history } from '@signalk/server-api'
import { depthReferenceFromPath } from './config'
import { aggregateStationaryWindow } from './stationary'
import type { CaptureEngine } from './capture'
import type { BathymetryConfig, Position, SoundingInput } from './types'

const MAX_RANGE_MS = 31 * 86_400_000
const CHUNK_MS = 6 * 3_600_000

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
        const response = await history.getValues({
          from: Temporal.Instant.fromEpochMilliseconds(cursor),
          to: Temporal.Instant.fromEpochMilliseconds(chunkEnd),
          context: 'vessels.self' as Context,
          resolution: this.config.historyResolutionSeconds,
          pathSpecs: this.pathSpecs()
        })
        for (const row of response.data) {
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

  private pathSpecs(): history.PathSpec[] {
    return [
      spec('navigation.position', 'first'),
      spec(this.config.depthPath, 'average'),
      spec('environment.tide.heightNow', 'average'),
      spec('navigation.speedOverGround', 'average')
    ]
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

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parsePosition(value: unknown): Position | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { latitude?: unknown; longitude?: unknown }
  const latitude = finite(candidate.latitude)
  const longitude = finite(candidate.longitude)
  if (latitude === undefined || longitude === undefined) return undefined
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined
  return { latitude, longitude }
}
