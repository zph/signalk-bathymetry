import type { Context, Delta, Path, ServerAPI, Unsubscribes } from '@signalk/server-api'
import { depthReferenceFromPath } from './config'
import { haversineMeters } from './geo'
import { PositionBuffer, fresh, nearest, type AlignedPosition } from './position'
import { correctGeometry, type Attitude } from './geometry'
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

const ATTITUDE_PATH = 'navigation.attitude'
const HEADING_PATH = 'navigation.headingTrue'

const SOG_PATH = 'navigation.speedOverGround'
const COG_PATH = 'navigation.courseOverGroundTrue'
const HEAVE_PATH = 'environment.heave'
const TIDE_PATH = 'environment.tide.heightNow'
const TIDE_STATION_PATH = 'environment.tide.stationName'

interface PendingDepth {
  depthM: number; timestampMs: number; source: string; context: string; receivedAtMs: number
  tide: TideProjection
  sog: TimestampedValue<number> | undefined
  cog: TimestampedValue<number> | undefined
  attitude: TimestampedValue<Attitude> | undefined
  heading: TimestampedValue<number> | undefined
}

export class CaptureEngine {
  private readonly unsubscribes: Unsubscribes = []
  private position?: TimestampedValue<Position>
  private readonly positions: PositionBuffer
  private pendingDepths: PendingDepth[] = []
  private attitude: TimestampedValue<Attitude> | undefined
  private heading: TimestampedValue<number> | undefined
  private movementAnchorSigmaM = 0
  private movementConfirmations = 0
  private lastMovementFixMs: number | undefined
  private lastProcessedMs: number | undefined
  private positionHasInstrumentTime = false
  private sog?: TimestampedValue<number>
  private cog?: TimestampedValue<number>
  private heave?: TimestampedValue<number>
  private tide?: TimestampedValue<number>
  private tideStationName?: TimestampedValue<string>
  private movementAnchor: Position | undefined
  private lastCapturePosition: Position | undefined
  private lastCaptureMs: number | undefined
  private trackId = newTrackId()
  private lastDepthSource: string | undefined
  private lastDepthEventMs?: number
  private queue: SoundingInput[] = []
  private stationaryWindow: SoundingInput[] = []
  private flushTimer: NodeJS.Timeout | undefined
  private running = false
  private lastError: string | undefined
  private rawError: string | undefined
  private withheldPosition = 0
  private withheldGeometry = 0

  constructor(
    private readonly app: ServerAPI,
    private readonly store: BathymetryStore,
    private readonly config: BathymetryConfig,
    private readonly journal?: RawJournal
  ) { this.positions = new PositionBuffer(config) }

  start(): void {
    if (this.running) return
    this.running = true
    const auxiliaryPaths = [
      this.config.positionPath,
      SOG_PATH,
      ATTITUDE_PATH,
      HEADING_PATH,
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
    this.flushTimer = setInterval(() => { this.drainDepths(); this.flush() }, this.config.flushIntervalMs)
  }

  stop(): void {
    this.running = false
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = undefined
    while (this.unsubscribes.length > 0) this.unsubscribes.pop()?.()
    this.drainDepths(true)
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
      queued: this.queue.length + this.pendingDepths.length,
      stationarySamples: this.stationaryWindow.length,
      withheldPosition: this.withheldPosition,
      withheldGeometry: this.withheldGeometry
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
    if (!depthSubscription) this.drainDepths()
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
          attitudeCorrection: this.config.attitudeCorrection, beamWidthDegrees: this.config.beamWidthDegrees,
          positionPath: this.config.positionPath, offsetProvenance: 'plugin-configuration',
          tideMetadataProvenance: 'plugin-configuration; method assumed predicted' },
        attitude: this.attitude ?? null, heading: this.heading ?? null, quality })
      this.rawError = undefined
    } catch (error) {
      this.rawError = errorMessage(error)
      this.setError(`Raw journal write failed: ${this.rawError}`)
    }
  }

  private updateAuxiliary(path: string, value: unknown, timestampMs: number, source: string, instrumentTime: boolean): void {
    if (path === this.config.positionPath) {
      const position = parsePosition(value)
      if (position && (!this.position || timestampMs > this.position.timestampMs)) {
        if (this.positions.add({ value: position, timestampMs, source })) {
          this.pendingDepths = []
          this.stationaryWindow = []
          this.movementAnchor = undefined
          this.lastCapturePosition = undefined
          this.lastCaptureMs = undefined
          this.movementConfirmations = 0
          this.lastMovementFixMs = undefined
          this.trackId = newTrackId()
        }
        this.position = { value: position, timestampMs, source }
        this.positionHasInstrumentTime = instrumentTime
      }
    } else if (path === ATTITUDE_PATH && value && typeof value === 'object') {
      const angles = value as Partial<Attitude>
      if (validNumber(angles.roll) && validNumber(angles.pitch) && (!this.attitude || timestampMs >= this.attitude.timestampMs)) {
        this.attitude = { value: { roll: angles.roll, pitch: angles.pitch }, timestampMs, source }
      }
    } else if (path === HEADING_PATH && validNumber(value) && (!this.heading || timestampMs >= this.heading.timestampMs)) {
      this.heading = { value, timestampMs, source }
    } else if (path === SOG_PATH && validNumber(value) && value >= 0 && (!this.sog || timestampMs >= this.sog.timestampMs)) {
      this.sog = { value, timestampMs, source }
    } else if (path === COG_PATH && validNumber(value) && (!this.cog || timestampMs >= this.cog.timestampMs)) {
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
    const tide = this.latestTideProjection(timestampMs)
    if (!tide || tide.stale || tide.datum !== this.config.targetDatum) return
    if (this.lastProcessedMs !== undefined && timestampMs <= this.lastProcessedMs) return
    this.pendingDepths.push({ depthM: rawDepthM, timestampMs, source, context, tide, receivedAtMs: Date.now(),
      sog: this.sog, cog: this.cog, attitude: this.attitude, heading: this.heading })
    this.pendingDepths.sort((a, b) => a.timestampMs - b.timestampMs)
    // Bound memory even if instruments flood duplicate timestamps.
    if (this.pendingDepths.length > 1000) this.pendingDepths.shift()
    this.drainDepths()
  }

  private drainDepths(force = false): void {
    while (this.pendingDepths.length) {
      const pending = this.pendingDepths[0]!
      const expired = force || Date.now() - pending.receivedAtMs >= this.config.maxLiveTimeSkewSeconds * 1000
      const position = this.positions.at(pending.timestampMs, pending.sog, pending.cog, expired)
      if (!position && !expired) break
      pending.attitude = nearest(pending.timestampMs, pending.attitude, this.attitude)
      pending.heading = nearest(pending.timestampMs, pending.heading, this.heading)
      if (this.config.attitudeCorrection && !expired &&
        (!fresh(pending.attitude, pending.timestampMs, this.config.attitudeMaxAgeSeconds) ||
         !fresh(pending.heading, pending.timestampMs, this.config.attitudeMaxAgeSeconds))) break
      this.pendingDepths.shift()
      if (!position) this.withheldPosition += 1
      if (!position || (this.lastProcessedMs !== undefined && pending.timestampMs <= this.lastProcessedMs)) continue
      this.lastProcessedMs = pending.timestampMs
      this.processDepth(pending, position)
    }
  }

  private processDepth(pending: PendingDepth, position: AlignedPosition): void {
    const { depthM: rawDepthM, timestampMs, source, context, tide } = pending
    if (
      (this.lastDepthSource !== undefined && this.lastDepthSource !== source) ||
      (this.lastDepthEventMs !== undefined &&
      timestampMs - this.lastDepthEventMs > this.config.segmentGapSeconds * 1000)
    ) {
      this.trackId = newTrackId()
      this.stationaryWindow = []
      this.movementAnchor = undefined
      this.movementConfirmations = 0
    }
    this.lastDepthSource = source
    this.lastDepthEventMs = timestampMs

    const sounding = this.makeSounding(rawDepthM, timestampMs, source, context, tide, position, pending)
    if (!sounding) return
    if (!this.isUnderway(position, timestampMs, pending.sog)) {
      this.collectStationary(sounding)
      return
    }
    // An incomplete stationary block is deliberately not converted into a point when movement starts.
    this.stationaryWindow = []
    if (!this.shouldCapture(timestampMs, position.value)) return
    this.queueSounding(sounding)
    // Movement uses the vessel position, never the attitude-shifted beam footprint.
    this.lastCapturePosition = position.value
    this.movementAnchor = position.value
    this.movementAnchorSigmaM = position.horizontalSigmaM
  }

  private makeSounding(
    rawDepthM: number,
    timestampMs: number,
    source: string,
    context: string,
    tide: TideProjection,
    position: AlignedPosition,
    pending: PendingDepth
  ): SoundingInput | undefined {
    const timeSkewMs = position.inputTimeSkewMs
    const geometry = correctGeometry(rawDepthM, position, timestampMs, pending.attitude, pending.heading, this.config)
    if (this.config.attitudeCorrection && !geometry) {
      this.withheldGeometry += 1
      this.setError('Mapped sounding withheld: attitude correction requires fresh roll/pitch, true heading, and valid raw beam geometry; raw recording continues')
      return
    }

    const reference = depthReferenceFromPath(this.config.depthPath)
    const offsetM =
      reference === 'belowKeel'
        ? this.config.surfaceToKeelM
        : reference === 'belowTransducer'
          ? this.config.surfaceToTransducerM
          : 0
    const datumDepthM = (geometry?.verticalDepthM ?? rawDepthM) + (geometry?.surfaceOffsetM ?? offsetM) - tide.heightM
    const timeSigmaM = (timeSkewMs / 1000) * 0.05
    const verticalSigmaM = Math.sqrt(
      this.config.depthSigmaM ** 2 +
        this.config.offsetSigmaM ** 2 +
        tide.sigmaM ** 2 +
        timeSigmaM ** 2 + (geometry?.verticalGeometrySigmaM ?? 0) ** 2
    )
    const passId = `${new Date(timestampMs).toISOString().slice(0, 10)}:${this.trackId}`
    const sounding: SoundingInput = {
      observedAtMs: timestampMs,
      ingestedAtMs: Date.now(),
      origin: 'live',
      context,
      trackId: this.trackId,
      passId,
      latitude: (geometry?.position ?? position.value).latitude,
      longitude: (geometry?.position ?? position.value).longitude,
      positionSource: position.source,
      horizontalSigmaM: geometry?.horizontalSigmaM ?? position.horizontalSigmaM,
      positionMethod: position.method,
      geometry: geometry?.metadata ?? { method: 'uncorrected' },
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
      sounding.surfaceToTransducerM = geometry?.surfaceOffsetM ?? this.config.surfaceToTransducerM
    }
    if (fresh(pending.sog, timestampMs, this.config.motionMaxAgeSeconds)) {
      sounding.sogMps = pending.sog.value
    }
    if (fresh(pending.cog, timestampMs, this.config.motionMaxAgeSeconds)) {
      sounding.cogTrueRad = pending.cog.value
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
    if (this.queue.length >= this.config.batchSize) this.flush()
  }

  private isUnderway(position: AlignedPosition, timestampMs: number, sog: TimestampedValue<number> | undefined): boolean {
    if (!this.movementAnchor) {
      this.movementAnchor = position.value
      this.movementAnchorSigmaM = position.horizontalSigmaM
    }
    if (fresh(sog, timestampMs, this.config.motionMaxAgeSeconds) && sog.value >= this.config.minSpeedMps) {
      this.movementConfirmations = 0
      return true
    }
    // Two-sigma displacement margin and three distinct fixes prevent isolated jitter
    // (or many depth pings paired to a single GPS fix) from ending a stationary window.
    if (position.fixTimestampMs !== this.lastMovementFixMs) {
      const margin = 2 * Math.hypot(this.movementAnchorSigmaM, position.horizontalSigmaM)
      const moved = haversineMeters(this.movementAnchor, position.value)
      this.movementConfirmations = moved > this.config.stationaryRadiusMeters + margin ? this.movementConfirmations + 1 : 0
      this.lastMovementFixMs = position.fixTimestampMs
    }
    return this.movementConfirmations >= 3
  }

  private shouldCapture(timestampMs: number, position: Position): boolean {
    if (this.lastCaptureMs === undefined || !this.lastCapturePosition) return true
    const elapsed = timestampMs - this.lastCaptureMs
    const moved = haversineMeters(this.lastCapturePosition, position)
    return elapsed >= this.config.maxIntervalSeconds * 1000 || moved >= this.config.distanceMeters
  }

  private setError(message: string): void {
    if (this.lastError === message) return
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
