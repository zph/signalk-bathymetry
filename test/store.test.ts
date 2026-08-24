import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { cellForPosition, hexCellCenter, mercatorToLonLat } from '../src/geo'
import { BathymetryStore } from '../src/store'
import { sounding } from './helpers'

function withStore(t: test.TestContext): { store: BathymetryStore; config: ReturnType<typeof normalizeConfig> } {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-test-'))
  const config = normalizeConfig({
    baseCellMeters: 10,
    outlierFloorM: 0.5,
    changeMinimumPasses: 3,
    changeMinimumDays: 2,
    recencyHalfLifeDays: 100_000
  })
  const store = new BathymetryStore(join(directory, 'test.sqlite'), config)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { store, config }
}

test('ingest is deduplicated and retains the datum reduction', (t) => {
  const { store, config } = withStore(t)
  const input = sounding(config, { rawDepthM: 5, tideHeightM: 1, datumDepthM: 5.5 })
  assert.deepEqual(store.ingest([input]), { inserted: 1, duplicate: 0 })
  assert.deepEqual(store.ingest([input]), { inserted: 0, duplicate: 1 })

  const cell = store.lookupCell(input.latitude, input.longitude, config.targetDatum)
  assert.ok(cell)
  assert.equal(cell.robustDepthM, 5.5)
  assert.equal(cell.soundingCount, 1)
  assert.equal(cell.observationCount, 1)
  assert.ok(cell.confidence <= 0.25)
  assert.ok(cell.confidenceReasons?.includes('single_observation'))
  assert.ok(cell.confidenceReasons?.includes('single_pass'))
  const raw = store.listSoundings({ limit: 10 })
  assert.equal(raw[0]?.datumDepthM, 5.5)
  assert.equal(raw[0]?.qcState, 'accepted')
})

test('a weak isolated depth disagreement is penalized by stronger adjacent cells', (t) => {
  const { store, config } = withStore(t)
  const weak = sounding(config, {
    observedAtMs: Date.UTC(2026, 0, 10),
    datumDepthM: 10,
    rawDepthM: 9.5,
    passId: 'weak-only-pass'
  })
  const center = cellForPosition(weak, config.baseCellMeters)
  const neighborOffsets = [[1, 0], [0, 1], [-1, 1]] as const
  const strong = neighborOffsets.flatMap(([offsetX, offsetY], neighborIndex) => {
    const mercator = hexCellCenter(center.x + offsetX, center.y + offsetY, config.baseCellMeters)
    const position = mercatorToLonLat(mercator.x, mercator.y)
    return [0, 1, 2].map((passIndex) => sounding(config, {
      latitude: position.latitude,
      longitude: position.longitude,
      observedAtMs: Date.UTC(2026, 0, 1 + passIndex),
      datumDepthM: 5 + neighborIndex * 0.03,
      rawDepthM: 4.5 + neighborIndex * 0.03,
      passId: `neighbor-${neighborIndex}-pass-${passIndex}`
    }))
  })
  store.ingest([...strong, weak])

  const cell = store.lookupCell(weak.latitude, weak.longitude, config.targetDatum)
  assert.ok(cell)
  assert.ok((cell.neighborSupportCount ?? 0) >= 2)
  assert.ok((cell.neighborDepthDeltaM ?? 0) > 4)
  assert.ok(cell.confidence <= 0.12)
  assert.ok(cell.confidenceReasons?.includes('neighbor_depth_disagreement'))
})

test('stationary aggregate counts samples without claiming extra passes', (t) => {
  const { store, config } = withStore(t)
  const input = sounding(config, {
    aggregationKind: 'stationary_window',
    sampleCount: 57,
    rejectedSampleCount: 4,
    passId: 'stationary-visit-a'
  })
  store.ingest([input])
  const cell = store.lookupCell(input.latitude, input.longitude, config.targetDatum)
  assert.ok(cell)
  assert.equal(cell.soundingCount, 57)
  assert.equal(cell.observationCount, 1)
  assert.equal(cell.passCount, 1)
  const records = store.listSoundings({ limit: 1 })
  assert.equal(records[0]?.sampleCount, 57)
  assert.equal(records[0]?.rejectedSampleCount, 4)
})

test('a shallow contradiction is shown immediately but promoted only after independent days', (t) => {
  const { store, config } = withStore(t)
  const day = 86_400_000
  const start = Date.UTC(2026, 0, 1)
  const atDepth = (datumDepthM: number, passId: string, observedAtMs: number) =>
    sounding(config, {
      observedAtMs,
      passId,
      rawDepthM: datumDepthM - config.surfaceToKeelM + 1,
      datumDepthM
    })

  store.ingest([
    atDepth(5, 'baseline-1', start),
    atDepth(5.05, 'baseline-2', start + day),
    atDepth(4.95, 'baseline-3', start + 2 * day)
  ])
  store.ingest([atDepth(3, 'new-1', start + 4 * day)])
  let cell = store.lookupCell(37.8, -122.4, config.targetDatum)
  assert.ok(cell)
  assert.equal(cell.changeState, 'suspected_shoaling')
  assert.ok(cell.robustDepthM > 4.9)
  assert.equal(cell.renderDepthM, 3)

  store.ingest([atDepth(3.05, 'new-2', start + 5 * day)])
  store.ingest([atDepth(2.95, 'new-3', start + 6 * day)])
  cell = store.lookupCell(37.8, -122.4, config.targetDatum)
  assert.ok(cell)
  assert.equal(cell.changeState, 'confirmed')
  assert.ok(Math.abs(cell.robustDepthM - 3) < 0.01)
  assert.equal(cell.passCount, 3)

  const quarantined = store.listSoundings({ qcState: 'quarantined', limit: 10 })
  assert.equal(quarantined.length, 3)
})

test('grid changes remap retained raw evidence and rebuild derived cells', (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-migration-test-'))
  const databasePath = join(directory, 'test.sqlite')
  const coarseConfig = normalizeConfig({ baseCellMeters: 10 })
  const input = sounding(coarseConfig, { rawDepthM: 7.25, datumDepthM: 6.75 })
  let store = new BathymetryStore(databasePath, coarseConfig)
  store.ingest([input])
  const before = store.listSoundings({ limit: 10 })
  store.close()

  const fineConfig = normalizeConfig({ baseCellMeters: 5 })
  store = new BathymetryStore(databasePath, fineConfig)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const after = store.listSoundings({ limit: 10 })
  assert.equal(after.length, before.length)
  assert.equal(after[0]?.rawDepthM, 7.25)
  assert.equal(after[0]?.datumDepthM, 6.75)
  assert.equal(store.stats().soundings, 1)
  assert.ok(store.lookupCell(input.latitude, input.longitude, fineConfig.targetDatum))
})
