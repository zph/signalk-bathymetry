import assert from 'node:assert/strict'
import test from 'node:test'
import type { Delta, ServerAPI } from '@signalk/server-api'
import { CaptureEngine } from '../src/capture'
import { normalizeConfig } from '../src/config'
import { offsetPosition } from '../src/position'
import { haversineMeters } from '../src/geo'
import type { BathymetryStore } from '../src/store'
import type { BathymetryConfig, SoundingInput } from '../src/types'

const origin = { latitude: 37, longitude: -122 }
function fixture(t: test.TestContext, options: Partial<BathymetryConfig> = {}) {
  const config = normalizeConfig({ stationaryMinimumSamples: 3, stationaryWindowSeconds: 10, ...options })
  const callbacks: Array<(delta: Delta) => void> = []
  const rows: SoundingInput[] = []
  const app = { subscriptionmanager: { subscribe: (_a: unknown, _b: unknown, _c: unknown, cb: (d: Delta) => void) => callbacks.push(cb) },
    debug() {}, error() {}, setPluginError() {}, setPluginStatus() {} } as unknown as ServerAPI
  const store = { ingest(batch: SoundingInput[]) { rows.push(...batch); return { inserted: batch.length, duplicate: 0 } },
    stats() { return { sourceSamples: rows.length, soundings: rows.length, cells: rows.length } } } as unknown as BathymetryStore
  const engine = new CaptureEngine(app, store, config)
  engine.start(); t.after(() => engine.stop())
  function emit(path: string, value: unknown, time: number, source = 'test') {
    callbacks[path === config.depthPath ? 1 : 0]!({ updates: [{ timestamp: new Date(time).toISOString(), $source: source, values: [{ path, value }] }] } as Delta)
  }
  emit('environment.tide.heightNow', 1, 1000)
  return { engine, rows, emit, config }
}

test('depth waits for the next GPS fix and is stored at its own timestamp', t => {
  const { engine, rows, emit, config } = fixture(t)
  emit('navigation.position', origin, 1000)
  emit('navigation.speedOverGround', 3, 2000)
  emit(config.depthPath, 10, 2000)
  engine.flush(); assert.equal(rows.length, 0)
  emit('navigation.position', offsetPosition(origin, 6, 0), 3000)
  engine.flush()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.observedAtMs, 2000)
  assert.equal(rows[0]!.positionMethod, 'interpolated')
  assert.ok(haversineMeters(rows[0]!, offsetPosition(origin, 3, 0)) < 0.01)
})

test('stale speed and five metre GPS jitter stay in a stationary window', t => {
  const { engine, rows, emit, config } = fixture(t)
  emit('navigation.speedOverGround', 5, 1000)
  for (const [time, east] of [[5000, 0], [6000, 5], [7000, -4], [15000, 3]]) {
    emit('navigation.position', offsetPosition(origin, east!, 0), time!)
    emit(config.depthPath, 10, time!)
  }
  engine.flush()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.aggregationKind, 'stationary_window')
  assert.equal(rows[0]!.sampleCount, 4)
  assert.equal(rows[0]!.sogMps, undefined)
  assert.ok(rows[0]!.horizontalSigmaM! >= 3)
})

test('displacement needs three distinct fixes beyond the GPS uncertainty margin', t => {
  const { engine, rows, emit, config } = fixture(t)
  for (const [time, east] of [[1000, 0], [2000, 20], [3000, 21]]) {
    emit('navigation.position', offsetPosition(origin, east!, 0), time!)
    emit(config.depthPath, 10, time!)
  }
  engine.flush(); assert.equal(rows.length, 0)
  emit('navigation.position', offsetPosition(origin, 22, 0), 4000)
  emit(config.depthPath, 10, 4000)
  engine.flush()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.aggregationKind, 'point')
})

test('fresh speed triggers movement; stale position without usable motion is never stamped onto depth', t => {
  const { engine, rows, emit, config } = fixture(t)
  emit('navigation.position', origin, 1000)
  emit('navigation.speedOverGround', 3, 1000)
  emit(config.depthPath, 10, 1000)
  engine.flush(); assert.equal(rows.length, 1)
  emit(config.depthPath, 10, 2500) // no course: cannot project
  engine.stop()
  assert.equal(rows.length, 1)
})

test('attitude shifts the sounding footprint without pretending that the boat moved', t => {
  const { engine, rows, emit, config } = fixture(t, { attitudeCorrection: true })
  for (const [time, roll] of [[1000, 0.3], [6000, -0.3], [11000, 0.3]]) {
    emit('navigation.position', origin, time!)
    emit('navigation.attitude', { roll: roll!, pitch: 0 }, time!)
    emit('navigation.headingTrue', 0, time!)
    emit(config.depthPath, 10, time!)
  }
  engine.flush()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.aggregationKind, 'stationary_window')
  assert.ok(Math.abs(rows[0]!.datumDepthM - (10 * Math.cos(0.3) - 0.5)) < 1e-8)
  assert.ok(rows[0]!.horizontalSigmaM! > 3)
})

test('enabled geometry refuses missing attitude while raw range is not reinterpreted', t => {
  const { engine, rows, emit, config } = fixture(t, { attitudeCorrection: true })
  emit('navigation.position', origin, 1000)
  emit('navigation.speedOverGround', 3, 1000)
  emit(config.depthPath, 10, 1000)
  engine.flush(); assert.equal(rows.length, 0)
  emit('navigation.attitude', { roll: Math.PI / 6, pitch: 0 }, 2000)
  emit('navigation.headingTrue', 0, 2000)
  emit('navigation.position', origin, 2000)
  emit(config.depthPath, 10, 2000)
  engine.stop()
  assert.equal(rows.length, 1)
  assert.equal(engine.status().withheldGeometry, 1)
  assert.equal(rows[0]!.rawDepthM, 10)
  assert.ok(Math.abs(rows[0]!.datumDepthM - (10 * Math.cos(Math.PI / 6) - 0.5)) < 1e-8)
})


test('attitude arriving after an exact-time GPS/depth ping is aligned before capture', t => {
  const { engine, rows, emit, config } = fixture(t, { attitudeCorrection: true })
  emit('navigation.position', origin, 1000)
  emit('navigation.speedOverGround', 3, 1000)
  emit(config.depthPath, 10, 1000)
  engine.flush(); assert.equal(rows.length, 0)
  emit('navigation.attitude', { roll: 0.2, pitch: 0 }, 1100)
  emit('navigation.headingTrue', 0, 1100)
  engine.flush()
  assert.equal(rows.length, 1)
  assert.ok(Math.abs(rows[0]!.datumDepthM - (10 * Math.cos(0.2) - 0.5)) < 1e-8)
})
