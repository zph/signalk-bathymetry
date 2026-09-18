import type { Context, ServerAPI, history } from '@signalk/server-api'
import { Temporal } from '@js-temporal/polyfill'
import { PositionBuffer } from './position'
import { correctGeometry } from './geometry'
import { spec, seriesFor, nearestWithin, plausibilityFilter, parsePosition, isNumberValue, isPositionValue, type TimePoint } from './history-series'
import { aggregateStationaryWindow } from './stationary'
import type { RebuildTarget } from './store'
import type { BathymetryConfig, SoundingInput } from './types'

type Provider = Awaited<ReturnType<NonNullable<ServerAPI['getHistoryApi']>>>
export const HISTORY_PATHS = {
  depth: 'environment.depth.belowTransducer', roll: 'navigation.attitude.roll', pitch: 'navigation.attitude.pitch',
  heading: 'navigation.headingTrue', sog: 'navigation.speedOverGround', cog: 'navigation.courseOverGroundTrue', tide: 'environment.tide.heightNow'
} as const
export type HistorySeries = Record<keyof typeof HISTORY_PATHS | 'position', TimePoint[]>

/** Independent queries avoid this provider's mixed-path merge bug. */
export async function fetchGeometryHistory(provider: Provider, fromMs: number, toMs: number, config: BathymetryConfig): Promise<HistorySeries> {
  if (config.historyResolutionSeconds !== 1) throw new Error('Historical attitude reconstruction requires one-second resolution')
  const paths = { ...HISTORY_PATHS, position: config.positionPath }
  const series = {} as HistorySeries
  const entries = Object.entries(paths) as Array<[keyof HistorySeries, string]>
  // Bound load on the shared InfluxDB provider.
  for (let i = 0; i < entries.length; i += 3) {
    await Promise.all(entries.slice(i, i + 3).map(async ([key, path]) => {
      const response = await provider.getValues({ from: Temporal.Instant.fromEpochMilliseconds(fromMs),
        to: Temporal.Instant.fromEpochMilliseconds(toMs), context: 'vessels.self' as Context,
        resolution: config.historyResolutionSeconds,
        // Use actual first values rather than independently averaging angles (heading wraps at 2pi).
        pathSpecs: [spec(path, 'first')] })
      const column = response.values.find(value => value.path === path)
      if (column && column.method !== 'first') throw new Error(`History provider did not honor first aggregation for ${path}`)
      series[key] = seriesFor(response, path, key === 'position' ? isPositionValue : isNumberValue)
    }))
  }
  series.tide = plausibilityFilter(series.tide)
  return series
}

export function correctedHistorySoundings(series: HistorySeries, config: BathymetryConfig): SoundingInput[] {
  const result: SoundingInput[] = []
  const positions = new PositionBuffer(config)
  const bucketMs = config.historyResolutionSeconds * 1000
  const toleranceMs = Math.max(bucketMs, config.attitudeMaxAgeSeconds * 1000)
  let positionIndex = 0
  for (const depth of series.depth) {
    const timestampMs = depth.atMs
    const rawDepthM = Number(depth.value)
    if (rawDepthM < config.instrumentMinM || rawDepthM > config.instrumentMaxM) continue
    while (positionIndex < series.position.length && series.position[positionIndex]!.atMs <= timestampMs + config.maxLiveTimeSkewSeconds * 1000) {
      const point = series.position[positionIndex++]!
      const value = parsePosition(point.value)
      if (value) positions.add({ value, timestampMs: point.atMs, source: 'history:unknown' })
    }
    const position = positions.at(timestampMs)
    const roll = nearestWithin(series.roll, timestampMs, toleranceMs)
    const pitch = nearestWithin(series.pitch, timestampMs, toleranceMs)
    const heading = nearestWithin(series.heading, timestampMs, toleranceMs)
    const sog = nearestWithin(series.sog, timestampMs, config.motionMaxAgeSeconds * 1000)
    const tide = nearestWithin(series.tide, timestampMs, Math.min(config.tideMaxAgeSeconds * 1000, 180_000))
    if (!position || !roll || !pitch || !heading || !sog || !tide || Number(sog.value) < 0) continue
    const skewMs = Math.max(position.inputTimeSkewMs, Math.abs(roll.atMs - timestampMs), Math.abs(pitch.atMs - timestampMs), Math.abs(heading.atMs - timestampMs))
    // Bucket timestamps are not instrument timestamps. Carry travel during the entire
    // bucket and join offset as uncertainty, even when bucket labels match exactly.
    position.horizontalSigmaM = Math.hypot(position.horizontalSigmaM, Number(sog.value) * (bucketMs + skewMs) / 1000)
    const geometry = correctGeometry(rawDepthM, position, timestampMs,
      { value: { roll: Number(roll.value), pitch: Number(pitch.value) }, timestampMs: Math.abs(roll.atMs - timestampMs) > Math.abs(pitch.atMs - timestampMs) ? roll.atMs : pitch.atMs, source: 'history:unknown' },
      { value: Number(heading.value), timestampMs: heading.atMs, source: 'history:unknown' },
      { ...config, attitudeCorrection: true, attitudeMaxAgeSeconds: toleranceMs / 1000 })
    if (!geometry) continue
    const date = new Date(timestampMs).toISOString().slice(0, 10)
    result.push({ observedAtMs: timestampMs, ingestedAtMs: Date.now(), origin: 'history', context: 'vessels.self',
      trackId: `history-${date}`, passId: `history-${date}`, ...geometry.position,
      positionSource: 'history:unknown', depthSource: 'history:unknown', rawDepthM, depthReference: 'belowTransducer',
      surfaceToTransducerM: geometry.surfaceOffsetM, tideHeightM: Number(tide.value), tideDatum: config.targetDatum,
      tideStationId: config.tideStationId, tideStationName: config.tideStationName, tideMethod: 'unknown',
      tideSource: 'history:unknown', tideObservedAtMs: tide.atMs,
      datumDepthM: geometry.verticalDepthM + geometry.surfaceOffsetM - Number(tide.value),
      verticalSigmaM: Math.hypot(config.depthSigmaM, config.offsetSigmaM, config.tideSigmaM, geometry.verticalGeometrySigmaM, 0.15 * (bucketMs + skewMs) / 1000),
      horizontalSigmaM: geometry.horizontalSigmaM, inputTimeSkewMs: bucketMs + skewMs,
      sogMps: Number(sog.value), positionMethod: 'history_geometry_v1', aggregationKind: 'point', sampleCount: 1,
      windowStartMs: timestampMs, windowEndMs: timestampMs,
      geometry: { ...geometry.metadata, historyResolutionSeconds: config.historyResolutionSeconds,
        historyAggregation: 'first', timestampOrigin: 'history-bucket', historyProvider: config.historyProvider ?? 'server-default',
        rollTimestampMs: roll.atMs, pitchTimestampMs: pitch.atMs, alignmentSkewMs: skewMs,
        installationAssumption: 'configured installation; historical vertical offset retained during replacement' } })
  }
  return result
}

/** Recreate an existing window; insufficient history leaves the original intact. */
export function reconstructTarget(target: RebuildTarget, soundings: readonly SoundingInput[], config: BathymetryConfig): SoundingInput | undefined {
  if (target.depthReference !== 'belowTransducer' || target.tideDatum !== config.targetDatum || target.tideStationId !== config.tideStationId || !Number.isFinite(target.offsetM)) return undefined
  const bucketMs = config.historyResolutionSeconds * 1000
  const start = Math.floor(target.windowStartMs / bucketMs) * bucketMs
  const end = Math.floor(target.windowEndMs / bucketMs) * bucketMs
  let low = 0, high = soundings.length
  while (low < high) { const mid = Math.floor((low + high) / 2); if (soundings[mid]!.observedAtMs < start) low = mid + 1; else high = mid }
  const samplesStart = low
  while (low < soundings.length && soundings[low]!.observedAtMs <= end) low += 1
  let samples = soundings.slice(samplesStart, low)
  if (!samples.length) return undefined
  const stationary = target.aggregationKind === 'stationary_window'
  if (stationary) {
    const required = Math.max(config.stationaryMinimumSamples, Math.ceil(Math.min(target.sampleCount, (end - start) / bucketMs + 1) * 0.8))
    if (samples.length < required || samples[0]!.observedAtMs - start > 2 * bucketMs || end - samples.at(-1)!.observedAtMs > 2 * bucketMs) return undefined
    // Do not bridge holes with medians or merge fragments of separate visits.
    if (samples.some((sample, i) => i > 0 && sample.observedAtMs - samples[i - 1]!.observedAtMs > Math.max(5_000, 3 * bucketMs))) return undefined
  } else {
    // A point needs the same history bucket, not an arbitrary nearby echo.
    samples = [samples.reduce((best, item) => Math.abs(item.observedAtMs - target.observedAtMs) < Math.abs(best.observedAtMs - target.observedAtMs) ? item : best)]
  }
  samples = samples.map(sample => ({ ...sample,
    surfaceToTransducerM: sample.surfaceToTransducerM! + target.offsetM - config.surfaceToTransducerM,
    datumDepthM: sample.datumDepthM + target.offsetM - config.surfaceToTransducerM }))
  const result = stationary ? aggregateStationaryWindow(samples, config, target.trackId) : samples[0]
  if (!result) return undefined
  return { ...result, observedAtMs: target.observedAtMs, windowStartMs: target.windowStartMs, windowEndMs: target.windowEndMs,
    trackId: target.trackId, passId: target.passId, tideStationId: target.tideStationId, tideStationName: target.tideStationName,
    positionMethod: 'history_geometry_v1',
    geometry: { ...result.geometry, replacesSoundingId: target.id, reconstruction: 'history-geometry-v1',
      historyResolutionSeconds: config.historyResolutionSeconds, historyAggregation: 'first',
      originalSampleCount: target.sampleCount, alignedHistorySamples: samples.length,
      originalOffsetM: target.offsetM, historyProvider: config.historyProvider ?? 'server-default' } }
}
