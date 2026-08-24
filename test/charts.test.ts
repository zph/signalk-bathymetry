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
    'signalk-bathymetry-water-now'
  ])
  for (const value of Object.values(resources)) {
    const resource = value as Record<string, unknown>
    assert.equal(resource.type, 'tilelayer')
    assert.equal(resource.format, 'png')
    assert.equal(resource.chartFormat, 'png')
    assert.match(String(resource.url), /\{z\}\/\{x\}\/\{y\}\.png/)
    assert.equal(resource.url, resource.tilemapUrl)
  }
  const datum = resources['signalk-bathymetry-datum'] as Record<string, unknown>
  const water = resources['signalk-bathymetry-water-now'] as Record<string, unknown>
  assert.match(String(datum.url), /mode=datum/)
  assert.match(String(water.url), /mode=water/)
  assert.match(String(datum.name), /\(m\)$/)
})
