import { median, robustSigma } from './statistics'
import type { BathymetryConfig, SoundingInput } from './types'

/**
 * Reduces a correlated stationary time window without pretending every ping is
 * independent. Individual spikes are counted separately from the block's
 * confidence-bearing estimate.
 */
export function aggregateStationaryWindow(
  samples: readonly SoundingInput[],
  config: BathymetryConfig,
  trackId: string
): SoundingInput | undefined {
  if (samples.length < config.stationaryMinimumSamples) return undefined
  const centerM = median(samples.map((sample) => sample.datumDepthM))
  const spreadM = robustSigma(samples.map((sample) => sample.datumDepthM))
  const thresholdM = Math.max(config.outlierFloorM, config.outlierMadMultiplier * spreadM)
  const accepted = samples.filter((sample) => Math.abs(sample.datumDepthM - centerM) <= thresholdM)
  if (accepted.length < config.stationaryMinimumSamples) return undefined
  const representative = accepted[Math.floor(accepted.length / 2)]
  if (!representative) return undefined
  const windowStartMs = samples[0]?.observedAtMs ?? representative.observedAtMs
  const windowEndMs = samples[samples.length - 1]?.observedAtMs ?? representative.observedAtMs
  // Adjacent pings are correlated. A ten-second decorrelation interval and cap
  // allow stable windows to improve random precision without erasing systematic
  // tide, offset, or installation uncertainty.
  const effectiveSamples = Math.max(
    1,
    Math.min(10, Math.floor((windowEndMs - windowStartMs) / 10_000) + 1)
  )
  const acceptedSpreadM = robustSigma(accepted.map((sample) => sample.datumDepthM))
  const timeSigmaM = (median(accepted.map((sample) => sample.inputTimeSkewMs)) / 1000) * 0.05
  return {
    ...representative,
    observedAtMs: windowEndMs,
    ingestedAtMs: Date.now(),
    trackId,
    passId: `${new Date(windowEndMs).toISOString().slice(0, 10)}:stationary:${trackId}`,
    latitude: median(accepted.map((sample) => sample.latitude)),
    longitude: median(accepted.map((sample) => sample.longitude)),
    rawDepthM: median(accepted.map((sample) => sample.rawDepthM)),
    tideHeightM: median(accepted.map((sample) => sample.tideHeightM)),
    datumDepthM: median(accepted.map((sample) => sample.datumDepthM)),
    verticalSigmaM: Math.sqrt(
      config.depthSigmaM ** 2 / effectiveSamples +
        config.offsetSigmaM ** 2 +
        config.tideSigmaM ** 2 +
        acceptedSpreadM ** 2 / effectiveSamples +
        timeSigmaM ** 2
    ),
    inputTimeSkewMs: Math.round(median(accepted.map((sample) => sample.inputTimeSkewMs))),
    aggregationKind: 'stationary_window',
    sampleCount: accepted.length,
    rejectedSampleCount: samples.length - accepted.length,
    windowStartMs,
    windowEndMs
  }
}
