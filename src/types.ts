export type DepthReference = 'belowKeel' | 'belowSurface' | 'belowTransducer'
export type SoundingOrigin = 'live' | 'history'
export type QcState = 'accepted' | 'quarantined' | 'rejected'
export type ChangeState =
  | 'stable'
  | 'suspected_shoaling'
  | 'candidate_deepening'
  | 'confirmed'

export interface Position {
  latitude: number
  longitude: number
}

export interface TimestampedValue<T> {
  value: T
  timestampMs: number
  source: string
}

export interface BathymetryConfig {
  depthPath: string
  depthSource?: string
  surfaceToKeelM: number
  surfaceToTransducerM: number
  targetDatum: string
  tideStationId: string
  tideStationName: string
  tideMaxAgeSeconds: number
  tideSigmaM: number
  depthSigmaM: number
  offsetSigmaM: number
  maxIntervalSeconds: number
  distanceMeters: number
  minSpeedMps: number
  stationaryRadiusMeters: number
  stationaryWindowSeconds: number
  stationaryMinimumSamples: number
  maxLiveTimeSkewSeconds: number
  segmentGapSeconds: number
  instrumentMinM: number
  instrumentMaxM: number
  baseCellMeters: number
  dangerUnderKeelM: number
  recencyHalfLifeDays: number
  outlierMadMultiplier: number
  outlierFloorM: number
  changeMinimumPasses: number
  changeMinimumDays: number
  overlayOpacity: number
  showDepthLabels: boolean
  depthLabelMinZoom: number
  minZoom: number
  maxZoom: number
  batchSize: number
  flushIntervalMs: number
  historyProvider?: string
  historyResolutionSeconds: number
  autoBackfillWhenEmpty: boolean
  autoBackfillDays: number
  autoBackfillDelaySeconds: number
}

export interface SoundingInput {
  observedAtMs: number
  ingestedAtMs: number
  origin: SoundingOrigin
  context: string
  trackId: string
  passId: string
  latitude: number
  longitude: number
  positionSource: string
  rawDepthM: number
  depthReference: DepthReference
  depthSource: string
  surfaceToKeelM?: number
  surfaceToTransducerM?: number
  tideHeightM: number
  tideDatum: string
  tideStationId: string
  tideStationName: string
  tideMethod: 'observed' | 'predicted' | 'unknown'
  tideSource: string
  tideObservedAtMs: number
  datumDepthM: number
  verticalSigmaM: number
  sogMps?: number
  cogTrueRad?: number
  heaveM?: number
  inputTimeSkewMs: number
  aggregationKind?: 'point' | 'stationary_window'
  sampleCount?: number
  rejectedSampleCount?: number
  windowStartMs?: number
  windowEndMs?: number
}

export interface SurfaceCell {
  cellX: number
  cellY: number
  datum: string
  robustDepthM: number
  renderDepthM: number
  conservativeDepthM: number
  verticalSigmaM: number
  confidence: number
  soundingCount: number
  observationCount: number
  passCount: number
  sourceCount: number
  oldestAtMs: number
  newestAtMs: number
  changeState: ChangeState
  updatedAtMs: number
}

export interface StoreStats {
  soundings: number
  sourceSamples: number
  rejectedStationarySamples: number
  accepted: number
  quarantined: number
  cells: number
  latestObservationMs?: number
  bounds?: [number, number, number, number]
}

export interface TideProjection {
  heightM: number
  sigmaM: number
  datum: string
  stationId: string
  stationName: string
  source: string
  method: 'observed' | 'predicted' | 'unknown'
  timestampMs: number
  stale: boolean
}

export interface CaptureStatus {
  running: boolean
  queued: number
  stationarySamples: number
  lastCaptureMs?: number
  lastError?: string
  latestTide?: TideProjection
}

export interface AutoBackfillStatus {
  state: 'disabled' | 'not_needed' | 'scheduled' | 'running' | 'complete' | 'failed'
  attempts: number
  lookbackDays: number
  nextAttemptMs?: number
  completedAtMs?: number
  importedRows?: number
  importedRecords?: number
  lastError?: string
}
