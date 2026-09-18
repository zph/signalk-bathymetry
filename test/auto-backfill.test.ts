import assert from 'node:assert/strict'
import test from 'node:test'
import { AutoBackfill } from '../src/auto-backfill'
import { normalizeConfig } from '../src/config'
import type { StoreStats } from '../src/types'

test('empty store automatically requests the configured 30-day history range', async () => {
  const config = normalizeConfig({ autoBackfillDays: 30 })
  let records = 0
  let requestedRange = 0
  const statuses: string[] = []
  const auto = new AutoBackfill(
    {
      debug: () => undefined,
      error: (message) => assert.fail(message),
      setPluginStatus: (message) => statuses.push(message)
    },
    { stats: () => stats(records) },
    {
      isRunning: () => false,
      run: async (fromMs, toMs) => {
        requestedRange = toMs - fromMs
        records = 42
        return { rows: 900, chunks: 120 }
      }
    },
    config
  )

  await auto.runNow()
  assert.equal(requestedRange, 30 * 86_400_000)
  assert.equal(auto.status().state, 'complete')
  assert.equal(auto.status().importedRows, 900)
  assert.equal(auto.status().importedRecords, 42)
  assert.match(statuses.at(-1) ?? '', /backfill complete/i)
})

test('non-empty store skips automatic history access', async () => {
  const config = normalizeConfig({})
  let calls = 0
  const auto = new AutoBackfill(
    { debug: () => undefined, error: () => undefined, setPluginStatus: () => undefined },
    { stats: () => stats(1) },
    {
      isRunning: () => false,
      run: async () => {
        calls += 1
        return { rows: 0, chunks: 0 }
      }
    },
    config
  )

  auto.start()
  await auto.runNow()
  assert.equal(calls, 0)
  assert.equal(auto.status().state, 'not_needed')
})

function stats(soundings: number): StoreStats {
  return {
    soundings,
    sourceSamples: soundings,
    rejectedStationarySamples: 0,
    accepted: soundings,
    quarantined: 0,
    cells: soundings
  }
}

test('attitude correction disables backfill that lacks synchronized attitude', async () => {
  const auto = new AutoBackfill(
    { debug() {}, error() {}, setPluginStatus() {} },
    { stats: () => stats(0) },
    { isRunning: () => false, run: async () => { assert.fail('must not import uncorrected ranges'); return { rows: 0, chunks: 0 } } },
    normalizeConfig({ attitudeCorrection: true })
  )
  auto.start(); await auto.runNow()
  assert.equal(auto.status().state, 'disabled')
  auto.stop()
})
