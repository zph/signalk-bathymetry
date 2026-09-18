import assert from 'node:assert/strict'
import test from 'node:test'
import type { ServerAPI } from '@signalk/server-api'
import { normalizeConfig } from '../src/config'
import { correctedHistorySoundings, reconstructTarget, fetchGeometryHistory, type HistorySeries } from '../src/history-geometry'
import type { RebuildTarget } from '../src/store'

const config = normalizeConfig({ attitudeCorrection: true, stationaryMinimumSamples: 3 })
const start = Date.UTC(2026, 8, 17, 12)
function series(count = 61): HistorySeries {
  const samples = (value: unknown) => Array.from({ length: count }, (_, i) => ({ atMs: start + i * 1000, value }))
  return { depth: samples(10), position: samples([-122, 37]), roll: samples(Math.PI / 6), pitch: samples(0),
    heading: samples(0), sog: samples(0), cog: samples(0), tide: [{ atMs: start, value: 1 }] }
}
const target: RebuildTarget = { id: 123, observedAtMs: start + 60100, windowStartMs: start + 100,
  windowEndMs: start + 60100, sampleCount: 61, rawDepthM: 10, offsetM: 0.8,
  tideDatum: 'MLLW', tideStationId: config.tideStationId, tideStationName: 'Old station name',
  depthReference: 'belowTransducer', passId: 'original-visit', trackId: 'original-track', aggregationKind: 'stationary_window' }

test('historical roll/pitch and heading correct depth and footprint with bucket uncertainty', () => {
  const input = series(3)
  input.sog = input.sog.map(point => ({ ...point, value: 3 }))
  const results = correctedHistorySoundings(input, config)
  assert.equal(results.length, 3)
  assert.ok(Math.abs(results[0]!.datumDepthM - (10 * Math.cos(Math.PI / 6) - 0.5)) < 1e-8)
  assert.ok(results[0]!.longitude < -122)
  assert.ok(results[0]!.horizontalSigmaM! > Math.sqrt(18))
  assert.equal(results[0]!.inputTimeSkewMs, 1000)
  assert.equal(results[0]!.geometry!.timestampOrigin, 'history-bucket')
  assert.equal(results[0]!.geometry!.historyAggregation, 'first')
})

test('missing or stale historical motion and tide produce gaps, not invented corrections', () => {
  for (const key of ['roll', 'pitch', 'heading', 'position', 'tide', 'sog'] as const) {
    const input = series(3); input[key] = []
    assert.equal(correctedHistorySoundings(input, config).length, 0, key)
  }
  const input = series(3)
  input.heading = [{ atMs: start - 3000, value: 0 }]
  assert.equal(correctedHistorySoundings(input, config).length, 0)
})

test('reconstructed windows preserve original time, pass and calibration, and require coverage', () => {
  const soundings = correctedHistorySoundings(series(), config)
  const rebuilt = reconstructTarget(target, soundings, config)!
  assert.ok(rebuilt)
  assert.equal(rebuilt.observedAtMs, target.observedAtMs)
  assert.equal(rebuilt.passId, target.passId)
  assert.equal(rebuilt.geometry!.replacesSoundingId, target.id)
  assert.equal(rebuilt.positionMethod, 'history_geometry_v1')
  assert.ok(Math.abs(rebuilt.datumDepthM - (10 * Math.cos(Math.PI / 6) - 0.2)) < 1e-8)
  assert.equal(reconstructTarget(target, soundings.slice(10), config), undefined)
  assert.equal(reconstructTarget(target, soundings.filter((_, i) => i < 20 || i > 30), config), undefined)
  assert.equal(reconstructTarget({ ...target, depthReference: 'belowKeel' }, soundings, config), undefined)
  assert.equal(reconstructTarget({ ...target, tideDatum: 'LAT' }, soundings, config), undefined)
})

test('point reconstruction requires its own bucket and retains uncertainty', () => {
  const soundings = correctedHistorySoundings(series(3), config)
  const point = { ...target, aggregationKind: 'point', sampleCount: 1, observedAtMs: start + 1100, windowStartMs: start + 1100, windowEndMs: start + 1100 }
  const rebuilt = reconstructTarget(point, soundings, config)!
  assert.equal(rebuilt.observedAtMs, point.observedAtMs)
  assert.equal(rebuilt.sampleCount, 1)
  assert.equal(reconstructTarget(point, [soundings[0]!], config), undefined)
})

test('provider queries request first samples independently and reject unsupported averaging', async () => {
  const calls: string[] = []
  type Provider = Awaited<ReturnType<NonNullable<ServerAPI['getHistoryApi']>>>
  const provider = { getValues: async (request: { pathSpecs: Array<{ path: string; aggregate: string }> }) => {
    assert.equal(request.pathSpecs.length, 1)
    assert.equal(request.pathSpecs[0]!.aggregate, 'first')
    calls.push(request.pathSpecs[0]!.path)
    return { values: [{ path: request.pathSpecs[0]!.path, method: 'first' }], data: [] }
  } } as unknown as Provider
  await fetchGeometryHistory(provider, start, start + 60_000, config)
  assert.equal(calls.length, 8)
  await assert.rejects(fetchGeometryHistory({ getValues: async () => ({ values: [{ path: 'navigation.attitude.roll', method: 'average' }], data: [] }) } as unknown as Provider, start, start + 60_000, config), /did not honor first/)
})
