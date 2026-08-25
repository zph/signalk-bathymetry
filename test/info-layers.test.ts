import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { METRIC_DEPTH_UNITS } from '../src/depth-units'
import { createInfoLayerProvider, INFO_LAYER_REFRESH_MS } from '../src/info-layers'

test('advertises Freeboard XYZ information layers with a real ten-minute refresh', async () => {
  const config = normalizeConfig({})
  const provider = createInfoLayerProvider(config, () => METRIC_DEPTH_UNITS)
  const resources = await provider.methods.listResources({})
  assert.deepEqual(Object.keys(resources).sort(), [
    'signalk-bathymetry-datum-live',
    'signalk-bathymetry-water-live'
  ])
  for (const resource of Object.values(resources) as Array<Record<string, unknown>>) {
    assert.equal(resource.type, 'InfoLayer')
    const values = resource.values as Record<string, unknown>
    assert.equal(values.sourceType, 'xyz')
    assert.equal(values.refreshInterval, INFO_LAYER_REFRESH_MS)
    assert.equal(values.opacity, 1)
    assert.equal(values.maxZoom, 24)
    assert.match(String(values.url), /\{z\}\/\{x\}\/\{y\}\.png/)
    assert.match(String(values.url), /[?&]style=hex11(?:&|$)/)
  }
})

test('persists safe Freeboard opacity changes without accepting generated field changes', async (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-layer-test-'))
  const preferencesPath = join(directory, 'info-layers.json')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const config = normalizeConfig({})
  const provider = createInfoLayerProvider(config, () => METRIC_DEPTH_UNITS, preferencesPath)

  await provider.methods.setResource('signalk-bathymetry-water-live', {
    type: 'InfoLayer',
    values: {
      opacity: 0.35,
      url: 'https://invalid.example/changed-by-client'
    }
  })

  const restarted = createInfoLayerProvider(config, () => METRIC_DEPTH_UNITS, preferencesPath)
  const resources = await restarted.methods.listResources({})
  const water = resources['signalk-bathymetry-water-live'] as Record<string, unknown>
  const values = water.values as Record<string, unknown>
  assert.equal(values.opacity, 0.35)
  assert.match(String(values.url), /^\/plugins\/signalk-bathymetry\/tiles\//)
  assert.doesNotMatch(String(values.url), /invalid\.example/)
})
