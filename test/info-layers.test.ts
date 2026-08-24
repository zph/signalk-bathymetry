import assert from 'node:assert/strict'
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
    assert.match(String(values.url), /\{z\}\/\{x\}\/\{y\}\.png/)
  }
})
