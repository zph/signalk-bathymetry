import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createChartProvider } from '../src/charts'
import { normalizeConfig } from '../src/config'
import { BathymetryStore } from '../src/store'
import { NoaaCsbStore } from '../src/noaa-csb'
import { NOAA_CSB_COVERAGE_STYLE_REVISION } from '../src/noaa-csb-viewport'

test('chart provider advertises one styled datum MVT chart', async (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-chart-test-'))
  const config = normalizeConfig({ overlayOpacity: 0.65 })
  const store = new BathymetryStore(join(directory, 'test.sqlite'), config)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const provider = createChartProvider(store, config)
  const resources = await provider.methods.listResources({})
  assert.deepEqual(Object.keys(resources), ['signalk-bathymetry-datum-vector'])

  const resource = resources['signalk-bathymetry-datum-vector'] as Record<string, unknown>
  assert.equal(resource.type, 'S-57')
  assert.equal(resource.format, 'pbf')
  assert.equal(resource.chartFormat, 'pbf')
  assert.deepEqual(resource.layers, ['DEPARE', 'SOUNDG'])
  assert.deepEqual(resource.chartLayers, ['DEPARE', 'SOUNDG'])
  assert.equal(resource.featureInfo, 'bathymetry-cell')
  assert.match(String(resource.url), /\{z\}\/\{x\}\/\{y\}\.pbf/)
  assert.match(String(resource.url), /mode=datum/)
  assert.equal(resource.url, resource.tilemapUrl)
  assert.equal(resource.style, '/plugins/signalk-bathymetry/vector-style.json')
  assert.equal(resource.defaultOpacity, 0.65)
  assert.equal(resource.defaultVisible, true)
  assert.deepEqual(resource.cellSizeControl, {
    queryParameter: 'cellScale',
    minimum: 0.25,
    maximum: 0.75,
    step: 0.25,
    default: 0.5
  })
  const scale = resource.cellSizeControl as {
    minimum: number
    maximum: number
    default: number
  }
  assert.equal((scale.minimum + scale.maximum) / 2, scale.default)
})

test('chart provider advertises cached NOAA depths as a separate disabled layer', async (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-csb-chart-test-'))
  const config = normalizeConfig({ overlayOpacity: 0.8 })
  const store = new BathymetryStore(join(directory, 'local.sqlite'), config)
  const csbStore = new NoaaCsbStore(join(directory, 'csb.sqlite'))
  t.after(() => {
    store.close()
    csbStore.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const provider = createChartProvider(store, config, csbStore)
  const resources = await provider.methods.listResources({})
  const resource = resources['signalk-bathymetry-noaa-csb-vector'] as Record<string, unknown>
  assert.ok(resource)
  assert.deepEqual(resource.layers, ['SOUNDG'])
  assert.equal(resource.defaultVisible, false)
  assert.equal(resource.defaultOpacity, 0.65)
  assert.match(String(resource.description), /unknown/i)
  assert.match(String(resource.description), /not for navigation/i)
  assert.deepEqual(resource.bounds, [-180, -85.051129, 180, 85.051129])
  assert.equal(resource.minzoom, 0)
  assert.equal(resource.name, 'NOAA Crowdsourced Bathymetry')
  assert.equal(resources['signalk-bathymetry-noaa-csb-coverage'], undefined)
  assert.match(String(resource.coverageTilemapUrl), /csb\/coverage/)
  assert.equal(
    resource.coverageTilemapUrl,
    `/plugins/signalk-bathymetry/csb/coverage/{z}/{x}/{y}.png?style=${NOAA_CSB_COVERAGE_STYLE_REVISION}`
  )
})
