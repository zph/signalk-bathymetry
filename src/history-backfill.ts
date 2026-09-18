import { Temporal } from '@js-temporal/polyfill'
import type { Context, ServerAPI } from '@signalk/server-api'
import { alignHistoryRows, spec, parsePosition, finite } from './history-series'
export { alignHistoryRows } from './history-series'
import { fetchGeometryHistory, correctedHistorySoundings, reconstructTarget } from './history-geometry'
import type { BathymetryStore } from './store'
import { depthReferenceFromPath } from './config'
import { aggregateStationaryWindow } from './stationary'
import type { CaptureEngine } from './capture'
import type { BathymetryConfig, SoundingInput } from './types'

const MAX_RANGE_MS = 31 * 86_400_000
const CHUNK_MS = 6 * 3_600_000
const TIDE_PATH = 'environment.tide.heightNow'
const SOG_PATH = 'navigation.speedOverGround'

export interface RebuildStatus {
  state: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled'
  fromMs?: number
  toMs?: number
  throughMs?: number
  examined: number
  replaced: number
  skipped: number
  chunks: number
  lastError?: string
}

export class HistoryBackfill {
  private running = false
  private stationaryWindow: SoundingInput[] = []
  private stationarySequence = 0
  private cancelled = false
  private rebuild: RebuildStatus = { state: 'idle', examined: 0, replaced: 0, skipped: 0, chunks: 0 }

  constructor(
    private readonly app: ServerAPI,
    private readonly capture: CaptureEngine,
    private readonly config: BathymetryConfig,
    private readonly store?: BathymetryStore
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
    if (this.store && this.config.attitudeCorrection && this.store.hasSoundingsInRange(fromMs, toMs)) {
      throw new Error('Existing soundings overlap this range; use /admin/rebuild-history to replace them without duplicates')
    }
    if (!this.app.getHistoryApi) throw new Error('This Signal K server does not expose History API access')
    this.running = true
    this.cancelled = false
    this.stationarySequence = 0
    let rows = 0
    let chunks = 0
    try {
      const history = await this.app.getHistoryApi(this.config.historyProvider)
      for (let cursor = fromMs; cursor < toMs; cursor += CHUNK_MS) {
        const chunkEnd = Math.min(toMs, cursor + CHUNK_MS)
        if (this.cancelled) throw new Error('History operation stopped')
        if (this.config.attitudeCorrection) {
          if (this.config.depthPath !== 'environment.depth.belowTransducer') throw new Error('Attitude history requires raw belowTransducer depth')
          const series = await fetchGeometryHistory(history, cursor - 180_000, chunkEnd + 180_000, this.config)
          if (this.cancelled) throw new Error('History operation stopped')
          for (const sounding of correctedHistorySoundings(series, this.config)) {
            if (sounding.observedAtMs < cursor || sounding.observedAtMs >= chunkEnd) continue
            this.routeSounding(sounding)
            rows += 1
          }
          this.capture.flush()
          chunks += 1
          continue
        }
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

  rebuildStatus(): RebuildStatus { return { ...this.rebuild } }

  stop(): void { this.cancelled = true }

  startRebuild(fromMs?: number, toMs?: number): RebuildStatus {
    if (this.running) throw new Error('A history operation is already running')
    if (!this.store || !this.app.getHistoryApi) throw new Error('History rebuild is unavailable')
    if (!this.config.attitudeCorrection || this.config.depthPath !== 'environment.depth.belowTransducer') {
      throw new Error('History geometry rebuild requires enabled raw-beam attitude correction')
    }
    const range = this.store.rebuildRange()
    fromMs ??= range?.fromMs
    toMs ??= range?.toMs
    if (fromMs === undefined || toMs === undefined) {
      this.rebuild = { state: 'complete', examined: 0, replaced: 0, skipped: 0, chunks: 0 }
      return this.rebuildStatus()
    }
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) throw new Error('Invalid historical rebuild range')
    this.capture.flush()
    this.cancelled = false
    this.running = true
    this.rebuild = { state: 'running', fromMs, toMs, examined: 0, replaced: 0, skipped: 0, chunks: 0 }
    void this.rebuildRange(fromMs, toMs).catch(error => {
      this.rebuild.state = this.cancelled ? 'cancelled' : 'failed'
      this.rebuild.lastError = error instanceof Error ? error.message : String(error)
      this.app.error(`Historical bathymetry rebuild: ${this.rebuild.lastError}`)
    }).finally(() => { this.running = false })
    return this.rebuildStatus()
  }

  private async rebuildRange(fromMs: number, toMs: number): Promise<void> {
    const provider = await this.app.getHistoryApi!(this.config.historyProvider)
    for (let cursor = fromMs; cursor < toMs; cursor += CHUNK_MS) {
      if (this.cancelled) throw new Error('History operation stopped')
      const end = Math.min(toMs, cursor + CHUNK_MS)
      const targets = this.store!.rebuildTargets(cursor, end)
      if (targets.length) {
        const queryStart = Math.min(...targets.map(target => target.windowStartMs)) - 180_000
        const series = await fetchGeometryHistory(provider, queryStart, end + 180_000, this.config)
        if (this.cancelled) throw new Error('History operation stopped')
        const soundings = correctedHistorySoundings(series, this.config)
        const replacements = targets.flatMap(target => {
          const sounding = reconstructTarget(target, soundings, this.config)
          return sounding ? [{ originalId: target.id, sounding }] : []
        })
        const replaced = this.store!.replaceFromHistory(replacements)
        this.rebuild.examined += targets.length
        this.rebuild.replaced += replaced
        this.rebuild.skipped += targets.length - replaced
      }
      this.rebuild.chunks += 1
      this.rebuild.throughMs = end
      this.app.debug(`Historical bathymetry rebuild: ${this.rebuild.replaced} replaced; ${this.rebuild.skipped} retained; through ${new Date(end).toISOString()}`)
      // Let live capture and HTTP handlers run between transactional chunks.
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    this.rebuild.state = 'complete'
  }

  private routeSounding(sounding: SoundingInput): void {
    const previous = this.stationaryWindow.at(-1)
    if (previous && sounding.observedAtMs - previous.observedAtMs > Math.max(5_000, 3 * this.config.historyResolutionSeconds * 1000)) {
      this.finishStationaryWindow()
    }
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
      horizontalSigmaM: Math.hypot(this.config.positionSigmaM, (sogMps ?? 3) * this.config.historyResolutionSeconds),
      positionMethod: 'history_unaligned',
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
