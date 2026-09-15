import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Delta, ServerAPI } from '@signalk/server-api'
import { RawJournal, type RawObservation } from '../src/raw-journal'
import { CaptureEngine } from '../src/capture'
import { normalizeConfig } from '../src/config'
import type { BathymetryStore } from '../src/store'

function observation(overrides: Partial<RawObservation> = {}): RawObservation {
  return { observedAtMs: 1000, receivedAtMs: 1100, timestampOrigin: 'instrument', depthM: 5,
    depthReference: 'belowTransducer', depthSource: 'sounder',
    position: { value: { latitude: 37, longitude: -122 }, timestampMs: 1000, source: 'gps' },
    tide: { heightM: 1, sigmaM: 0.1, datum: 'MLLW', stationId: 'test', stationName: 'Test', source: 'tides', method: 'predicted', timestampMs: 1000, stale: false },
    surfaceOffsetM: 0.5, installation: { sounderModel: 'Test' }, quality: [], ...overrides }
}

test('raw values survive restart; corrected depths are derived and unavailable without usable tide', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bathymetry-journal-'))
  const path = join(dir, 'raw.sqlite')
  let journal = new RawJournal(path)
  try {
    journal.append(observation())
    journal.append(observation({ receivedAtMs: 1200 })) // duplicate delivery
    journal.append(observation({ observedAtMs: 2000, tide: null }))
    journal.append(observation({ observedAtMs: 3000, tide: { ...observation().tide!, stale: true } }))
    journal.close(); journal = new RawJournal(path)
    const rows = journal.read()
    assert.equal(rows.length, 3)
    assert.equal(rows[0]!.raw.depthM, 5)
    assert.equal(rows[0]!.correctedDepthM, 4.5)
    assert.equal(rows[1]!.correctedDepthM, null)
    assert.equal(rows[2]!.correctedDepthM, null)
    assert.equal(journal.sample().features.length, 3) // tide is not an export prerequisite
    assert.equal(journal.sample().features[0]!.properties.depth, 5)
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('publication is opt-in; pending exports retry identically and only acknowledged batches advance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bathymetry-export-'))
  const path = join(dir, 'raw.sqlite')
  let journal = new RawJournal(path)
  try {
    journal.append(observation())
    journal.append(observation({ observedAtMs: 2000, quality: ['stale-position'] }))
    assert.throws(() => journal.prepare(), /disabled/)
    assert.equal(journal.status().acknowledgedThroughId, 0)
    journal.sample()
    assert.equal(journal.status().acknowledgedThroughId, 0)
    journal.consent(true)
    const first = journal.prepare(2)
    assert.equal(first.sample.properties.excludedCount, 1)
    journal.append(observation({ observedAtMs: 3000 }))
    journal.close(); journal = new RawJournal(path)
    assert.deepEqual(journal.prepare(), first)
    journal.consent(false)
    assert.throws(() => journal.acknowledge(first.batchId!), /disabled/)
    journal.consent(true)
    assert.throws(() => journal.acknowledge('invented'), /Unknown/)
    journal.acknowledge(first.batchId!)
    journal.acknowledge(first.batchId!) // idempotent receipt
    assert.equal(journal.status().acknowledgedThroughId, first.sample.properties.throughId)
    assert.equal(journal.prepare().sample.features.length, 1)
    assert.throws(() => journal.read(-1), /Invalid/)
    assert.throws(() => journal.read(0, 10001), /Invalid/)
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('capture keeps unaggregated stationary soundings without tides and flags future GPS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bathymetry-capture-'))
  const journal = new RawJournal(join(dir, 'raw.sqlite'))
  const callbacks: Array<(delta: Delta) => void> = []
  const app = { subscriptionmanager: { subscribe: (_options: unknown, _unsub: unknown, _error: unknown, callback: (delta: Delta) => void) => callbacks.push(callback) },
    debug() {}, error() {}, setPluginError() {}, setPluginStatus() {} } as unknown as ServerAPI
  const config = normalizeConfig({})
  const engine = new CaptureEngine(app, {} as BathymetryStore, config, journal)
  const delta = (path: string, value: unknown, time: number) => ({ updates: [{ timestamp: new Date(time).toISOString(), $source: 'test', values: [{ path, value }] }] }) as Delta
  try {
    engine.start()
    callbacks[0]!(delta('navigation.position', { latitude: 37, longitude: -122 }, 10000))
    for (const time of [10000, 10100, 10200]) callbacks[1]!(delta(config.depthPath, 5, time))
    callbacks[1]!(delta(config.depthPath, 6, 1000))
    callbacks[1]!(delta(config.depthPath, 0, 10300))
    assert.equal(journal.read().length, 5)
    assert.equal(journal.sample().features.length, 3)
    assert.deepEqual(journal.read()[3]!.raw.quality, ['stale-position'])
    assert.equal(journal.read()[0]!.correctedDepthM, null)
  } finally { engine.stop(); journal.close(); rmSync(dir, { recursive: true, force: true }) }
})
