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
