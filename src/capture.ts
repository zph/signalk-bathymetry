import type { Context, Delta, Path, ServerAPI, Unsubscribes } from '@signalk/server-api'
import { depthReferenceFromPath } from './config'
import { haversineMeters } from './geo'
import { aggregateStationaryWindow } from './stationary'
import type { BathymetryStore } from './store'
import type { RawJournal } from './raw-journal'
import type {
  BathymetryConfig,
  CaptureStatus,
  Position,
  SoundingInput,
  TideProjection,
  TimestampedValue
} from './types'

const SOG_PATH = 'navigation.speedOverGround'
const COG_PATH = 'navigation.courseOverGroundTrue'
const HEAVE_PATH = 'environment.heave'
const TIDE_PATH = 'environment.tide.heightNow'
const TIDE_STATION_PATH = 'environment.tide.stationName'

export class CaptureEngine {
  private readonly unsubscribes: Unsubscribes = []
  private position?: TimestampedValue<Position>
  private positionHasInstrumentTime = false
  private sog?: TimestampedValue<number>
  private cog?: TimestampedValue<number>
  private heave?: TimestampedValue<number>
  private tide?: TimestampedValue<number>
  private tideStationName?: TimestampedValue<string>
  private movementAnchor?: Position
  private lastCapturePosition?: Position
  private lastCaptureMs?: number
  private trackId = newTrackId()
  private lastDepthEventMs?: number
  private queue: SoundingInput[] = []
  private stationaryWindow: SoundingInput[] = []
  private flushTimer: NodeJS.Timeout | undefined
  private running = false
  private lastError: string | undefined
  private rawError: string | undefined

  constructor(
    private readonly app: ServerAPI,
    private readonly store: BathymetryStore,
    private readonly config: BathymetryConfig,
    private readonly journal?: RawJournal
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    const auxiliaryPaths = [
      this.config.positionPath,
      SOG_PATH,
      COG_PATH,
      HEAVE_PATH,
      TIDE_PATH,
      TIDE_STATION_PATH
    ]
    this.app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self' as Context,
        subscribe: auxiliaryPaths.map((path) => ({
          path: path as Path,
          policy: 'instant' as const,
          minPeriod: 100
        })),
        sourcePolicy: 'preferred'
      },
      this.unsubscribes,
      (error) => this.setError(`Auxiliary subscription failed: ${String(error)}`),
      (delta) => this.handleDelta(delta, false)
    )
    this.app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self' as Context,
        subscribe: [
          {
            path: this.config.depthPath as Path,
            policy: 'instant' as const,
            minPeriod: 0
          }
        ],
        sourcePolicy: this.config.depthSource ? 'all' : 'preferred'
      },
      this.unsubscribes,
      (error) => this.setError(`Depth subscription failed: ${String(error)}`),
      (delta) => this.handleDelta(delta, true)
    )
    this.flushTimer = setInterval(() => this.flush(), this.config.flushIntervalMs)
  }

  stop(): void {
    this.running = false
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = undefined
    while (this.unsubscribes.length > 0) this.unsubscribes.pop()?.()
    this.finishStationaryWindow()
    this.flush()
  }

  enqueueHistorical(sounding: SoundingInput): void {
    this.queue.push(sounding)
    if (this.queue.length >= this.config.batchSize) this.flush()
  }

  flush(): void {
    if (this.queue.length === 0) return
    const batch = this.queue
    this.queue = []
    try {
      const result = this.store.ingest(batch)
      this.app.debug(
        `bathymetry flush: inserted=${result.inserted} duplicate=${result.duplicate}`
      )
      this.lastError = undefined
      this.updatePluginStatus()
    } catch (error) {
      this.queue.unshift(...batch)
      this.setError(`Database flush failed: ${errorMessage(error)}`)
    }
  }

  status(): CaptureStatus {
    const status: CaptureStatus = {
      running: this.running,
      queued: this.queue.length,
      stationarySamples: this.stationaryWindow.length
    }
    if (this.lastCaptureMs !== undefined) status.lastCaptureMs = this.lastCaptureMs
    if (this.lastError !== undefined) status.lastError = this.lastError
    const tide = this.latestTideProjection()
    if (tide) status.latestTide = tide
    return status
  }

  latestTideProjection(atMs = Date.now()): TideProjection | undefined {
    if (!this.tide) return undefined
    const ageMs = Math.abs(atMs - this.tide.timestampMs)
    return {
      heightM: this.tide.value,
      sigmaM: this.config.tideSigmaM,
      datum: this.config.targetDatum,
      stationId: this.config.tideStationId,
      stationName: this.tideStationName?.value ?? this.config.tideStationName,
      source: this.tide.source,
      method: 'predicted',
      timestampMs: this.tide.timestampMs,
      stale: ageMs > this.config.tideMaxAgeSeconds * 1000
    }
  }

  private handleDelta(delta: Delta, depthSubscription: boolean): void {
    const context = String(delta.context ?? 'vessels.self')
    for (const update of delta.updates) {
      if (!('values' in update)) continue
      const timestampMs = parseTimestamp(update.timestamp) ?? Date.now()
      const source = String(update.$source ?? sourceFromLegacy(update.source) ?? 'unknown')
      for (const pathValue of update.values) {
        if (pathValue.state?.timedOut) continue
        const path = String(pathValue.path)
        if (depthSubscription && path === this.config.depthPath) {
          if (this.config.depthSource && source !== this.config.depthSource) continue
          if (typeof pathValue.value === 'number') {
            this.recordRaw(pathValue.value, timestampMs, source, parseTimestamp(update.timestamp) !== undefined)
            this.handleDepth(pathValue.value, timestampMs, source, context)
          }
          continue
        }
        this.updateAuxiliary(path, pathValue.value, timestampMs, source, parseTimestamp(update.timestamp) !== undefined)
      }
    }
  }

  rawStatus(): { error: string | null } { return { error: this.rawError ?? null } }

  private recordRaw(depthM: number, observedAtMs: number, source: string, instrumentTime: boolean): void {
    if (!this.journal || !Number.isFinite(depthM)) return
    const reference = depthReferenceFromPath(this.config.depthPath)
    const quality: string[] = []
    if (!instrumentTime) quality.push('receipt-time-only')
    if (observedAtMs > Date.now() + 1000) quality.push('future-observation-time')
    if (!this.position) quality.push('missing-position')
    else if (Math.abs(observedAtMs - this.position.timestampMs) > this.config.maxLiveTimeSkewSeconds * 1000) quality.push('stale-position')
    if (this.position && !this.positionHasInstrumentTime) quality.push('position-receipt-time-only')
    if (depthM <= 0 || depthM < this.config.instrumentMinM || depthM > this.config.instrumentMaxM) quality.push('outside-instrument-range')
    try {
      this.journal.append({ observedAtMs, receivedAtMs: Date.now(), timestampOrigin: instrumentTime ? 'instrument' : 'receipt',
        depthM, depthReference: reference, depthSource: source, position: this.position ?? null,
        tide: this.latestTideProjection(observedAtMs) ?? null,
        surfaceOffsetM: reference === 'belowSurface' ? 0 : reference === 'belowKeel' ? this.config.surfaceToKeelM : this.config.surfaceToTransducerM,
        installation: { ...this.config.recordingInstallation, depthPath: this.config.depthPath,
          positionPath: this.config.positionPath, offsetProvenance: 'plugin-configuration',
          tideMetadataProvenance: 'plugin-configuration; method assumed predicted' }, quality })
      this.rawError = undefined
    } catch (error) {
      this.rawError = errorMessage(error)
      this.setError(`Raw journal write failed: ${this.rawError}`)
    }
  }

  private updateAuxiliary(path: string, value: unknown, timestampMs: number, source: string, instrumentTime: boolean): void {
    if (path === this.config.positionPath) {
      const position = parsePosition(value)
      if (position) {
        this.position = { value: position, timestampMs, source }
        this.positionHasInstrumentTime = instrumentTime
        this.movementAnchor ??= position
      }
    } else if (path === SOG_PATH && validNumber(value)) {
      this.sog = { value, timestampMs, source }
    } else if (path === COG_PATH && validNumber(value)) {
      this.cog = { value, timestampMs, source }
    } else if (path === HEAVE_PATH && validNumber(value)) {
      this.heave = { value, timestampMs, source }
    } else if (path === TIDE_PATH && validNumber(value)) {
      this.tide = { value, timestampMs, source }
    } else if (path === TIDE_STATION_PATH && typeof value === 'string' && value.trim()) {
      this.tideStationName = { value: value.trim(), timestampMs, source }
    }
  }

  private handleDepth(rawDepthM: number, timestampMs: number, source: string, context: string): void {
    if (!Number.isFinite(rawDepthM)) return
    if (rawDepthM < this.config.instrumentMinM || rawDepthM > this.config.instrumentMaxM) return
    if (!this.position) return
    const timeSkewMs = Math.abs(timestampMs - this.position.timestampMs)
    if (timeSkewMs > this.config.maxLiveTimeSkewSeconds * 1000) return
    const tide = this.latestTideProjection(timestampMs)
    if (!tide || tide.stale || tide.datum !== this.config.targetDatum) return

    if (
      this.lastDepthEventMs !== undefined &&
      timestampMs - this.lastDepthEventMs > this.config.segmentGapSeconds * 1000
    ) {
      this.trackId = newTrackId()
    }
    this.lastDepthEventMs = timestampMs

    const sounding = this.makeSounding(rawDepthM, timestampMs, source, context, tide)
    if (!this.isUnderway(this.position.value)) {
      this.collectStationary(sounding)
      return
    }
    // An incomplete stationary block is deliberately not converted into a point when movement starts.
    this.stationaryWindow = []
    if (!this.shouldCapture(timestampMs, this.position.value)) return
    this.queueSounding(sounding)
  }

  private makeSounding(
    rawDepthM: number,
    timestampMs: number,
    source: string,
    context: string,
    tide: TideProjection
  ): SoundingInput {
    if (!this.position) throw new Error('Position disappeared while constructing a sounding')
    const timeSkewMs = Math.abs(timestampMs - this.position.timestampMs)

    const reference = depthReferenceFromPath(this.config.depthPath)
    const offsetM =
      reference === 'belowKeel'
        ? this.config.surfaceToKeelM
        : reference === 'belowTransducer'
          ? this.config.surfaceToTransducerM
          : 0
    const datumDepthM = rawDepthM + offsetM - tide.heightM
    const timeSigmaM = (timeSkewMs / 1000) * 0.05
    const verticalSigmaM = Math.sqrt(
      this.config.depthSigmaM ** 2 +
        this.config.offsetSigmaM ** 2 +
        tide.sigmaM ** 2 +
        timeSigmaM ** 2
    )
    const passId = `${new Date(timestampMs).toISOString().slice(0, 10)}:${this.trackId}`
    const sounding: SoundingInput = {
      observedAtMs: timestampMs,
      ingestedAtMs: Date.now(),
      origin: 'live',
      context,
      trackId: this.trackId,
      passId,
      latitude: this.position.value.latitude,
      longitude: this.position.value.longitude,
      positionSource: this.position.source,
      rawDepthM,
      depthReference: reference,
      depthSource: source,
      tideHeightM: tide.heightM,
      tideDatum: tide.datum,
      tideStationId: tide.stationId,
      tideStationName: tide.stationName,
      tideMethod: tide.method,
      tideSource: tide.source,
      tideObservedAtMs: tide.timestampMs,
      datumDepthM,
      verticalSigmaM,
      inputTimeSkewMs: timeSkewMs,
      aggregationKind: 'point',
      sampleCount: 1,
      rejectedSampleCount: 0,
      windowStartMs: timestampMs,
      windowEndMs: timestampMs
    }
    if (reference === 'belowKeel') sounding.surfaceToKeelM = this.config.surfaceToKeelM
    if (reference === 'belowTransducer') {
      sounding.surfaceToTransducerM = this.config.surfaceToTransducerM
    }
    if (this.sog && Math.abs(timestampMs - this.sog.timestampMs) <= 5000) {
      sounding.sogMps = this.sog.value
    }
    if (this.cog && Math.abs(timestampMs - this.cog.timestampMs) <= 5000) {
      sounding.cogTrueRad = this.cog.value
    }
    if (this.heave && Math.abs(timestampMs - this.heave.timestampMs) <= 5000) {
      sounding.heaveM = this.heave.value
    }
    return sounding
  }

  private collectStationary(sounding: SoundingInput): void {
    this.stationaryWindow.push(sounding)
    const first = this.stationaryWindow[0]
    if (
      first &&
      sounding.observedAtMs - first.observedAtMs >= this.config.stationaryWindowSeconds * 1000
    ) {
      this.finishStationaryWindow()
    }
  }

  private finishStationaryWindow(): void {
    const samples = this.stationaryWindow
    this.stationaryWindow = []
    const aggregate = aggregateStationaryWindow(samples, this.config, this.trackId)
    if (aggregate) this.queueSounding(aggregate)
  }

  private queueSounding(sounding: SoundingInput): void {
    this.queue.push(sounding)
    this.lastCaptureMs = sounding.observedAtMs
    this.lastCapturePosition = { latitude: sounding.latitude, longitude: sounding.longitude }
    this.movementAnchor = this.lastCapturePosition
    if (this.queue.length >= this.config.batchSize) this.flush()
  }

  private isUnderway(position: Position): boolean {
    const speedUnderway = this.sog !== undefined && this.sog.value >= this.config.minSpeedMps
    const movedUnderway =
      this.movementAnchor !== undefined &&
      haversineMeters(this.movementAnchor, position) >= this.config.stationaryRadiusMeters
    return speedUnderway || movedUnderway
  }

  private shouldCapture(timestampMs: number, position: Position): boolean {
    if (this.lastCaptureMs === undefined || !this.lastCapturePosition) return true
    const elapsed = timestampMs - this.lastCaptureMs
    const moved = haversineMeters(this.lastCapturePosition, position)
    return elapsed >= this.config.maxIntervalSeconds * 1000 || moved >= this.config.distanceMeters
  }

  private setError(message: string): void {
    this.lastError = message
    this.app.error(message)
    this.app.setPluginError(message)
  }

  private updatePluginStatus(): void {
    const stats = this.store.stats()
    this.app.setPluginStatus(
      `Recording; ${stats.sourceSamples} samples in ${stats.soundings} records, ${stats.cells} cells, datum ${this.config.targetDatum}`
    )
  }
}

function parsePosition(value: unknown): Position | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { latitude?: unknown; longitude?: unknown }
  if (!validNumber(candidate.latitude) || !validNumber(candidate.longitude)) return undefined
  if (candidate.latitude < -90 || candidate.latitude > 90) return undefined
  if (candidate.longitude < -180 || candidate.longitude > 180) return undefined
  return { latitude: candidate.latitude, longitude: candidate.longitude }
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function sourceFromLegacy(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { label?: unknown; src?: unknown; type?: unknown }
  for (const part of [candidate.label, candidate.src, candidate.type]) {
    if (typeof part === 'string' && part) return part
  }
  return undefined
}

function newTrackId(): string {
  return `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
