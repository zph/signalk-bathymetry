import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig, pluginSchema } from '../src/config'

test('position path defaults to navigation.position and accepts a custom Signal K path', () => {
  assert.equal(normalizeConfig({}).positionPath, 'navigation.position')
  assert.equal(
    normalizeConfig({ positionPath: ' navigation.gnss.position ' }).positionPath,
    'navigation.gnss.position'
  )
  assert.equal(normalizeConfig({ positionPath: '   ' }).positionPath, 'navigation.position')

  const properties = (pluginSchema() as { properties: Record<string, Record<string, unknown>> })
    .properties
  assert.equal(properties.positionPath?.default, 'navigation.position')
})

test('surface cell size centers the five-meter default in its slider range', () => {
  const properties = (pluginSchema() as { properties: Record<string, Record<string, unknown>> })
    .properties
  const field = properties.baseCellMeters

  assert.equal(field?.minimum, 1)
  assert.equal(field?.maximum, 9)
  assert.equal(field?.multipleOf, 1)
  assert.equal(field?.default, 5)
  assert.equal((Number(field?.minimum) + Number(field?.maximum)) / 2, field?.default)
})

test('depth label relative size is configurable within safe portrayal bounds', () => {
  assert.equal(normalizeConfig({}).depthLabelRelativeSize, 1)
  assert.equal(normalizeConfig({ depthLabelRelativeSize: 0.1 }).depthLabelRelativeSize, 0.5)
  assert.equal(normalizeConfig({ depthLabelRelativeSize: 3 }).depthLabelRelativeSize, 2)

  const properties = (pluginSchema() as { properties: Record<string, Record<string, unknown>> })
    .properties
  assert.deepEqual(properties.depthLabelRelativeSize, {
    type: 'number',
    title: 'Depth label relative size (1 = normal)',
    minimum: 0.5,
    maximum: 2,
    multipleOf: 0.1,
    default: 1
  })
})
