import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
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
  assert.equal(raw[0]?.depthReference, 'belowKeel')
  assert.equal(raw[0]?.surfaceToKeelM, config.surfaceToKeelM)
  assert.equal(raw[0]?.surfaceToTransducerM, undefined)
  assert.equal(raw[0]?.belowSurfaceDepthM, 5 + config.surfaceToKeelM)
  assert.equal(raw[0]?.qcState, 'accepted')
})

test('raw sounding records expose the offset and below-surface depth for every reference', (t) => {
  const { store, config } = withStore(t)
  const transducerInput = sounding(config, {
    observedAtMs: Date.UTC(2026, 0, 1),
    passId: 'transducer',
    rawDepthM: 4,
    depthReference: 'belowTransducer',
    surfaceToTransducerM: 0.6,
    datumDepthM: 3.6
  })
  delete transducerInput.surfaceToKeelM
  const surfaceInput = sounding(config, {
    observedAtMs: Date.UTC(2026, 0, 2),
    passId: 'surface',
    rawDepthM: 5,
    depthReference: 'belowSurface',
    datumDepthM: 4
  })
  delete surfaceInput.surfaceToKeelM
  store.ingest([transducerInput, surfaceInput])

  const [surface, transducer] = store.listSoundings({ limit: 10 })
  assert.equal(surface?.belowSurfaceDepthM, 5)
  assert.equal(transducer?.surfaceToTransducerM, 0.6)
  assert.equal(transducer?.belowSurfaceDepthM, 4.6)
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

test('horizontal uncertainty persists and prevents repeated uncertain fixes gaining high cell confidence', t => {
  const { store, config } = withStore(t)
  const inputs = Array.from({ length: 12 }, (_, i) => sounding(config, {
    observedAtMs: Date.UTC(2026, 0, i + 1), passId: `pass-${i}`, depthSource: `source-${i % 2}`,
    horizontalSigmaM: 20, positionMethod: 'interpolated', geometry: { method: 'uncorrected' }
  }))
  store.ingest(inputs)
  const cell = store.lookupCell(inputs[0]!.latitude, inputs[0]!.longitude, config.targetDatum)!
  assert.equal(cell.horizontalSigmaM, 20)
  assert.ok(cell.confidence < 0.05)
  assert.ok(cell.confidenceReasons?.includes('horizontal_uncertainty_exceeds_cell'))
  const raw = store.listSoundings({ limit: 1 })[0]!
  assert.equal(raw.horizontalSigmaM, 20)
  assert.equal(raw.positionMethod, 'interpolated')
  store.reprocessAll()
  assert.equal(store.lookupCell(inputs[0]!.latitude, inputs[0]!.longitude, config.targetDatum)!.horizontalSigmaM, 20)
})

test('geometry-corrected surface depth is not reconstructed from uncorrected beam range', t => {
  const { store, config } = withStore(t)
  const input = sounding(config, { rawDepthM: 10, depthReference: 'belowTransducer', surfaceToTransducerM: 0.5,
    datumDepthM: 8.16, horizontalSigmaM: 4, geometry: { method: 'beam-center-with-cone-uncertainty' } })
  store.ingest([input])
  assert.equal(store.listSoundings({ limit: 1 })[0]!.belowSurfaceDepthM, 9.16)
})


test('migration retains legacy evidence and rebuilds horizontal confidence on reopen', t => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-test-'))
  const path = join(directory, 'legacy.sqlite')
  const config = normalizeConfig({})
  let store = new BathymetryStore(path, config)
  const input = sounding(config)
  store.ingest([input]); store.close()
  const db = new DatabaseSync(path)
  db.exec(`ALTER TABLE raw_soundings DROP COLUMN horizontal_sigma_mm;
    ALTER TABLE raw_soundings DROP COLUMN position_method;
    ALTER TABLE raw_soundings DROP COLUMN geometry_json;
    ALTER TABLE surface_cells DROP COLUMN horizontal_sigma_mm;
    UPDATE qc_classifications SET model_version=4;
    UPDATE surface_cells SET model_version=4;
    PRAGMA user_version=3;`)
  db.close()
  store = new BathymetryStore(path, config)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  assert.equal(store.stats().soundings, 1)
  assert.equal(store.listSoundings({ limit: 1 })[0]!.positionMethod, 'legacy_unaligned')
  assert.equal(store.listSoundings({ limit: 1 })[0]!.horizontalSigmaM, config.positionSigmaM)
  assert.equal(store.lookupCell(input.latitude, input.longitude, config.targetDatum)!.horizontalSigmaM, config.positionSigmaM)
})
