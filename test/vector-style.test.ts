import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { vectorStyle } from '../src/vector-style'

test('Freeboard vector style uses tile label visibility and relative size metadata', () => {
  const style = vectorStyle(normalizeConfig({}))
  const layers = style.layers as Array<Record<string, unknown>>
  const label = layers.find((layer) => layer.id === 'bathymetry-label')
  assert.ok(label)
  assert.deepEqual(label.filter, ['==', ['get', 'BATHY_SHOW_DEPTH_LABELS'], true])
  const layout = label.layout as Record<string, unknown>
  assert.deepEqual(layout['text-size'], [
    '*',
    ['interpolate', ['linear'], ['zoom'], 13, 11, 20, 14],
    ['to-number', ['get', 'BATHY_LABEL_RELATIVE_SIZE'], 1]
  ])
})
