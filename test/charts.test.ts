import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createChartProvider } from '../src/charts'
import { normalizeConfig } from '../src/config'
import { BathymetryStore } from '../src/store'
import { METRIC_DEPTH_UNITS } from '../src/depth-units'

test('chart provider advertises datum and current-water XYZ overlays', async (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-chart-test-'))
  const config = normalizeConfig({})
  const store = new BathymetryStore(join(directory, 'test.sqlite'), config)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const provider = createChartProvider(store, config, () => METRIC_DEPTH_UNITS)
  const resources = await provider.methods.listResources({})
  assert.deepEqual(Object.keys(resources).sort(), [
    'signalk-bathymetry-datum',
    'signalk-bathymetry-datum-vector',
    'signalk-bathymetry-water-now',
    'signalk-bathymetry-water-now-vector'
  ])
  for (const value of [
    resources['signalk-bathymetry-datum'],
    resources['signalk-bathymetry-water-now']
  ]) {
    const resource = value as Record<string, unknown>
    assert.equal(resource.type, 'tilelayer')
    assert.equal(resource.format, 'png')
    assert.equal(resource.chartFormat, 'png')
    assert.equal(resource.maxzoom, 24)
    assert.match(String(resource.url), /\{z\}\/\{x\}\/\{y\}\.png/)
    assert.match(String(resource.url), /[?&]style=hex12(?:&|$)/)
    assert.equal(resource.url, resource.tilemapUrl)
  }
  const datum = resources['signalk-bathymetry-datum'] as Record<string, unknown>
  const water = resources['signalk-bathymetry-water-now'] as Record<string, unknown>
  assert.match(String(datum.url), /mode=datum/)
  assert.match(String(water.url), /mode=water/)
  assert.match(String(datum.name), /\(m\)$/)
  assert.match(String(datum.description), /enable this or the tide-adjusted chart, not both/)
  assert.match(String(water.description), /enable this or the datum chart, not both/)

  for (const id of ['signalk-bathymetry-datum-vector', 'signalk-bathymetry-water-now-vector']) {
    const resource = resources[id] as Record<string, unknown>
    assert.equal(resource.type, 'S-57')
    assert.equal(resource.format, 'pbf')
    assert.equal(resource.chartFormat, 'pbf')
    assert.deepEqual(resource.layers, ['DEPARE', 'SOUNDG'])
    assert.deepEqual(resource.chartLayers, ['DEPARE', 'SOUNDG'])
    assert.equal(resource.featureInfo, 'bathymetry-cell')
    assert.match(String(resource.url), /\{z\}\/\{x\}\/\{y\}\.pbf/)
    assert.equal(resource.url, resource.tilemapUrl)
  }
})
