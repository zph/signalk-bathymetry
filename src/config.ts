import type { BathymetryConfig, DepthDisplayMode, DepthReference } from './types'

export const DEFAULT_CONFIG: BathymetryConfig = {
  positionPath: 'navigation.position',
  depthPath: 'environment.depth.belowTransducer',
  surfaceToKeelM: 1.5,
  surfaceToTransducerM: 0.5,
  targetDatum: 'MLLW',
  tideStationId: 'vessel/default',
  tideStationName: 'Signal K selected station',
  tideMaxAgeSeconds: 900,
  tideSigmaM: 0.25,
  depthSigmaM: 0.2,
  offsetSigmaM: 0.1,
  maxIntervalSeconds: 1,
  distanceMeters: 2,
  minSpeedMps: 0.25,
  stationaryRadiusMeters: 3,
  stationaryWindowSeconds: 60,
  stationaryMinimumSamples: 10,
  maxLiveTimeSkewSeconds: 2,
  segmentGapSeconds: 300,
  instrumentMinM: 0.4,
  instrumentMaxM: 120,
  baseCellMeters: 5,
  dangerUnderKeelM: 0.75,
  recencyHalfLifeDays: 365,
  outlierMadMultiplier: 4.5,
  outlierFloorM: 0.5,
  changeMinimumPasses: 3,
  changeMinimumDays: 2,
  overlayOpacity: 0.55,
  qcBaseChart: 'noaa-enc',
  showDepthLabels: true,
  depthLabelRelativeSize: 1,
  displayDepth: 'predicted' as DepthDisplayMode,
  minZoom: 8,
  maxZoom: 24,
  batchSize: 20,
  flushIntervalMs: 1000,
  historyResolutionSeconds: 1,
  autoBackfillWhenEmpty: true,
  autoBackfillDays: 30,
  autoBackfillDelaySeconds: 15
}

type RawConfig = Partial<BathymetryConfig>

export function normalizeConfig(raw: object): BathymetryConfig {
  const input = raw as RawConfig
  const config: BathymetryConfig = { ...DEFAULT_CONFIG, ...input }

  config.targetDatum = nonEmpty(config.targetDatum, DEFAULT_CONFIG.targetDatum).toUpperCase()
  config.positionPath = nonEmpty(config.positionPath, DEFAULT_CONFIG.positionPath)
  config.depthPath = nonEmpty(config.depthPath, DEFAULT_CONFIG.depthPath)
  config.tideStationId = nonEmpty(config.tideStationId, DEFAULT_CONFIG.tideStationId)
  config.tideStationName = nonEmpty(config.tideStationName, DEFAULT_CONFIG.tideStationName)
  config.surfaceToKeelM = nonNegative(config.surfaceToKeelM, DEFAULT_CONFIG.surfaceToKeelM)
  config.surfaceToTransducerM = nonNegative(
    config.surfaceToTransducerM,
    DEFAULT_CONFIG.surfaceToTransducerM
  )
  config.dangerUnderKeelM = nonNegative(
    config.dangerUnderKeelM,
    DEFAULT_CONFIG.dangerUnderKeelM
  )
  config.overlayOpacity = clamp(config.overlayOpacity, 0, 1)
  config.qcBaseChart =
    typeof config.qcBaseChart === 'string'
      ? config.qcBaseChart.trim()
      : DEFAULT_CONFIG.qcBaseChart
  config.showDepthLabels =
    typeof config.showDepthLabels === 'boolean'
      ? config.showDepthLabels
      : DEFAULT_CONFIG.showDepthLabels
  config.depthLabelRelativeSize = clamp(config.depthLabelRelativeSize, 0.5, 2)
  config.displayDepth =
    config.displayDepth === 'conservative' || config.displayDepth === 'predicted'
      ? config.displayDepth
      : DEFAULT_CONFIG.displayDepth
  config.minZoom = Math.round(clamp(config.minZoom, 0, 22))
  config.maxZoom = Math.round(clamp(config.maxZoom, config.minZoom, 24))
  config.baseCellMeters = positive(config.baseCellMeters, DEFAULT_CONFIG.baseCellMeters)
  config.maxIntervalSeconds = positive(
    config.maxIntervalSeconds,
    DEFAULT_CONFIG.maxIntervalSeconds
  )
  config.distanceMeters = positive(config.distanceMeters, DEFAULT_CONFIG.distanceMeters)
  config.flushIntervalMs = Math.round(positive(config.flushIntervalMs, 1000))
  config.batchSize = Math.round(positive(config.batchSize, 20))
  config.stationaryWindowSeconds = positive(
    config.stationaryWindowSeconds,
    DEFAULT_CONFIG.stationaryWindowSeconds
  )
  config.stationaryMinimumSamples = Math.max(3, Math.round(config.stationaryMinimumSamples))
  config.autoBackfillWhenEmpty =
    typeof config.autoBackfillWhenEmpty === 'boolean'
      ? config.autoBackfillWhenEmpty
      : DEFAULT_CONFIG.autoBackfillWhenEmpty
  config.autoBackfillDays = clamp(config.autoBackfillDays, 1, 31)
  config.autoBackfillDelaySeconds = clamp(config.autoBackfillDelaySeconds, 0, 600)
  config.changeMinimumPasses = Math.max(1, Math.round(config.changeMinimumPasses))
  config.changeMinimumDays = Math.max(0, config.changeMinimumDays)
  if (config.instrumentMaxM <= config.instrumentMinM) {
    config.instrumentMaxM = DEFAULT_CONFIG.instrumentMaxM
  }
  return config
}

export function depthReferenceFromPath(path: string): DepthReference {
  if (path.endsWith('.belowSurface')) return 'belowSurface'
  if (path.endsWith('.belowTransducer')) return 'belowTransducer'
  if (path.endsWith('.belowKeel')) return 'belowKeel'
  throw new Error(`Unsupported depth path: ${path}`)
}

export function pluginSchema(): object {
  return {
    type: 'object',
    title: 'Local Bathymetry',
    properties: {
      positionPath: {
        type: 'string',
        title: 'Vessel position path (relative to vessels.self)',
        default: DEFAULT_CONFIG.positionPath
      },
      depthPath: {
        type: 'string',
        title: 'Depth path',
        default: DEFAULT_CONFIG.depthPath,
        enum: [
          'environment.depth.belowKeel',
          'environment.depth.belowSurface',
          'environment.depth.belowTransducer'
        ]
      },
      depthSource: {
        type: 'string',
        title: 'Depth source ($source), blank for preferred source'
      },
      surfaceToKeelM: numberField('Waterline to keel (m)', 0, 20, 0.01, 1.5),
      surfaceToTransducerM: numberField(
        'Waterline to transducer (m)',
        0,
        20,
        0.01,
        0.5
      ),
      targetDatum: {
        type: 'string',
        title: 'Tide/vertical datum',
        default: DEFAULT_CONFIG.targetDatum
      },
      tideStationId: {
        type: 'string',
        title: 'Tide station/model id',
        default: DEFAULT_CONFIG.tideStationId
      },
      tideStationName: {
        type: 'string',
        title: 'Tide station/model name',
        default: DEFAULT_CONFIG.tideStationName
      },
      tideMaxAgeSeconds: numberField('Maximum tide age (seconds)', 1, 86400, 1, 900),
      tideSigmaM: numberField('Tide uncertainty (m, 1 sigma)', 0, 10, 0.01, 0.25),
      depthSigmaM: numberField('Depth sensor uncertainty (m, 1 sigma)', 0, 10, 0.01, 0.2),
      offsetSigmaM: numberField('Vertical offset uncertainty (m, 1 sigma)', 0, 10, 0.01, 0.1),
      maxIntervalSeconds: numberField('Maximum sampling interval (s)', 0.1, 60, 0.1, 1),
      distanceMeters: numberField('Distance sampling trigger (m)', 0.1, 100, 0.1, 2),
      minSpeedMps: numberField('Stationary speed threshold (m/s)', 0, 10, 0.05, 0.25),
      stationaryRadiusMeters: numberField('Stationary position radius (m)', 0.5, 100, 0.5, 3),
      stationaryWindowSeconds: numberField(
        'Stationary robust window (seconds)',
        10,
        3600,
        1,
        60
      ),
      stationaryMinimumSamples: numberField(
        'Minimum samples per stationary window',
        3,
        10000,
        1,
        10
      ),
      baseCellMeters: numberField('Surface cell size (m)', 1, 9, 1, 5),
      dangerUnderKeelM: numberField(
        'Danger threshold: under-keel clearance (m)',
        0,
        20,
        0.05,
        0.75
      ),
      recencyHalfLifeDays: numberField('Confidence half-life (days)', 1, 36500, 1, 365),
      overlayOpacity: numberField('Vector chart opacity', 0, 1, 0.05, 0.55),
      qcBaseChart: {
        type: 'string',
        title: 'QC map backing chart id or name (blank for automatic NOAA ENC)',
        default: DEFAULT_CONFIG.qcBaseChart
      },
      showDepthLabels: {
        type: 'boolean',
        title: 'Show depth numbers inside every displayed hex cell',
        default: true
      },
      depthLabelRelativeSize: numberField(
        'Depth label relative size (1 = normal)',
        0.5,
        2,
        0.1,
        1
      ),
      displayDepth: {
        type: 'string',
        title: 'Displayed depth estimate',
        description:
          'Conservative shows the shallow-biased 95 percent lower bound. ' +
          'Predicted shows the best depth estimate without the safety margin (default).',
        default: 'predicted',
        enum: ['conservative', 'predicted']
      },
      instrumentMinM: numberField('Sounder minimum valid depth (m)', 0, 100, 0.1, 0.4),
      instrumentMaxM: numberField('Sounder maximum valid depth (m)', 1, 12000, 1, 120),
      historyProvider: {
        type: 'string',
        title: 'History provider id, blank for server default'
      },
      autoBackfillWhenEmpty: {
        type: 'boolean',
        title: 'Automatically backfill when the local store is empty',
        default: true
      },
      autoBackfillDays: numberField(
        'Automatic empty-store lookback (days)',
        1,
        31,
        1,
        30
      ),
      autoBackfillDelaySeconds: numberField(
        'Delay before automatic backfill (seconds)',
        0,
        600,
        1,
        15
      )
    }
  }
}

function numberField(
  title: string,
  minimum: number,
  maximum: number,
  multipleOf: number,
  defaultValue: number
): object {
  return { type: 'number', title, minimum, maximum, multipleOf, default: defaultValue }
}

function nonEmpty(value: string, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}
