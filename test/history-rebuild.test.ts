import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerAPI } from '@signalk/server-api'
import { normalizeConfig } from '../src/config'
import { BathymetryStore } from '../src/store'
import { HistoryBackfill } from '../src/history-backfill'
import type { CaptureEngine } from '../src/capture'
import { sounding } from './helpers'

const start = Date.UTC(2026, 8, 17, 12)
function setup(t: test.TestContext, missingHeading = false) {
  const config = normalizeConfig({ attitudeCorrection: true, stationaryMinimumSamples: 3 })
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-test-'))
  const path = join(directory, 'rebuild.sqlite')
  const store = new BathymetryStore(path, config)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const values: Record<string, unknown> = {
    'navigation.position': [-122.4, 37.8], 'environment.depth.belowTransducer': 10,
    'navigation.attitude.roll': Math.PI / 6, 'navigation.attitude.pitch': 0,
    'navigation.headingTrue': 0, 'navigation.speedOverGround': 0, 'navigation.courseOverGroundTrue': 0,
    'environment.tide.heightNow': 1
  }
  let requests = 0
  const app = { error() {}, debug() {}, getHistoryApi: async () => ({
    getValues: async ({ pathSpecs }: { pathSpecs: Array<{ path: string }> }) => {
      requests += 1
      const path = pathSpecs[0]!.path
      return { values: [{ path, method: 'first' }],
        data: missingHeading && path === 'navigation.headingTrue' ? [] : Array.from({ length: 61 }, (_, i) => [new Date(start + i * 1000).toISOString(), values[path]]) }
    }
  }) } as unknown as ServerAPI
  const capture = { flush() {}, enqueueHistorical() {} } as unknown as CaptureEngine
  const runner = new HistoryBackfill(app, capture, config, store)
  const original = sounding(config, { depthReference: 'belowTransducer', surfaceToTransducerM: 0.5,
    observedAtMs: start + 60100, windowStartMs: start + 100, windowEndMs: start + 60100,
    rawDepthM: 10, datumDepthM: 9.5, positionMethod: 'legacy_unaligned',
    aggregationKind: 'stationary_window', sampleCount: 61, passId: 'retained-visit' })
  store.ingest([original])
  return { runner, store, requests: () => requests }
}
async function complete(runner: HistoryBackfill) {
  for (let i = 0; runner.isRunning() && i < 1000; i++) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(runner.isRunning(), false)
}

test('background rebuild fetches history, replaces one record, and a retry does not duplicate it', async t => {
  const { runner, store, requests } = setup(t)
  assert.equal(runner.startRebuild().state, 'running')
  assert.throws(() => runner.startRebuild(), /already running/)
  await complete(runner)
  assert.equal(runner.rebuildStatus().state, 'complete')
  assert.equal(runner.rebuildStatus().replaced, 1)
  assert.equal(runner.rebuildStatus().skipped, 0)
  assert.equal(store.stats().soundings, 1)
  assert.equal(store.stats().supersededSoundings, 1)
  assert.equal(store.listSoundings({ limit: 1 })[0]!.passId, 'retained-visit')
  assert.equal(requests(), 8)
  assert.equal(runner.startRebuild().state, 'complete')
  assert.equal(requests(), 8)
  store.reprocessAll()
  assert.equal(store.stats().soundings, 1)
})

test('missing historical attitude keeps the original and reports the skipped record', async t => {
  const { runner, store } = setup(t, true)
  runner.startRebuild(); await complete(runner)
  assert.equal(runner.rebuildStatus().skipped, 1)
  assert.equal(runner.rebuildStatus().replaced, 0)
  assert.equal(store.stats().supersededSoundings, 0)
  assert.equal(store.listSoundings({ limit: 1 })[0]!.positionMethod, 'legacy_unaligned')
})

test('stopping a pending rebuild prevents later writes to the store', async t => {
  const { runner, store } = setup(t)
  runner.startRebuild(); runner.stop(); await complete(runner)
  assert.equal(runner.rebuildStatus().state, 'cancelled')
  assert.equal(store.stats().supersededSoundings, 0)
})

test('ordinary geometry backfill cannot append duplicates over existing live records', async t => {
  const { runner } = setup(t)
  await assert.rejects(runner.run(start, start + 120_000), /use \/admin\/rebuild-history/)
})
