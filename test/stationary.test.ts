import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { aggregateStationaryWindow } from '../src/stationary'
import { sounding } from './helpers'

test('stationary windows quarantine spikes and preserve sample evidence', () => {
  const config = normalizeConfig({ stationaryMinimumSamples: 10 })
  const start = Date.UTC(2026, 0, 1)
  const samples = Array.from({ length: 61 }, (_, index) => {
    const datumDepthM = index === 12 || index === 47 ? 14 : 5 + ((index % 3) - 1) * 0.02
    const tideHeightM = 1
    const rawDepthM = datumDepthM - config.surfaceToKeelM + tideHeightM
    return sounding(config, {
      observedAtMs: start + index * 1000,
      rawDepthM,
      tideHeightM,
      datumDepthM
    })
  })

  const aggregate = aggregateStationaryWindow(samples, config, 'anchor-visit-1')
  assert.ok(aggregate)
  assert.equal(aggregate.aggregationKind, 'stationary_window')
  assert.equal(aggregate.sampleCount, 59)
  assert.equal(aggregate.rejectedSampleCount, 2)
  assert.ok(Math.abs(aggregate.datumDepthM - 5) < 0.01)
  assert.ok(aggregate.verticalSigmaM < samples[0]!.verticalSigmaM)
  assert.match(aggregate.passId, /stationary:anchor-visit-1$/)
})

test('stationary windows with too little evidence are not persisted', () => {
  const config = normalizeConfig({ stationaryMinimumSamples: 10 })
  assert.equal(
    aggregateStationaryWindow([sounding(config), sounding(config)], config, 'short'),
    undefined
  )
})
