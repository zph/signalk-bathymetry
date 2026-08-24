import type { BathymetryConfig, SoundingInput } from '../src/types'

export function sounding(
  config: BathymetryConfig,
  overrides: Partial<SoundingInput> = {}
): SoundingInput {
  const rawDepthM = overrides.rawDepthM ?? 5
  const tideHeightM = overrides.tideHeightM ?? 1
  const surfaceToKeelM = overrides.surfaceToKeelM ?? config.surfaceToKeelM
  const observedAtMs = overrides.observedAtMs ?? Date.UTC(2026, 0, 1)
  return {
    observedAtMs,
    ingestedAtMs: observedAtMs + 100,
    origin: 'live',
    context: 'vessels.self',
    trackId: 'track-a',
    passId: 'pass-a',
    latitude: 37.8,
    longitude: -122.4,
    positionSource: 'gps.test',
    rawDepthM,
    depthReference: 'belowKeel',
    depthSource: 'sounder.test',
    surfaceToKeelM,
    tideHeightM,
    tideDatum: config.targetDatum,
    tideStationId: config.tideStationId,
    tideStationName: config.tideStationName,
    tideMethod: 'predicted',
    tideSource: 'tide.test',
    tideObservedAtMs: observedAtMs,
    datumDepthM: rawDepthM + surfaceToKeelM - tideHeightM,
    verticalSigmaM: 0.3,
    inputTimeSkewMs: 0,
    aggregationKind: 'point',
    sampleCount: 1,
    rejectedSampleCount: 0,
    windowStartMs: observedAtMs,
    windowEndMs: observedAtMs,
    ...overrides
  }
}
