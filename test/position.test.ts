import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { PositionBuffer, offsetPosition } from '../src/position'
import { haversineMeters } from '../src/geo'

const origin = { latitude: 37, longitude: -122 }
const fix = (timestampMs: number, eastM: number, source = 'gps') => ({ value: offsetPosition(origin, eastM, 0), timestampMs, source })
const number = (value: number, timestampMs: number) => ({ value, timestampMs, source: 'gps' })

test('positions interpolate at depth time without shrinking correlated GNSS uncertainty', () => {
  const buffer = new PositionBuffer(normalizeConfig({}))
  buffer.add(fix(1000, 0)); buffer.add(fix(3000, 6))
  const result = buffer.at(2000)!
  assert.equal(result.method, 'interpolated')
  assert.ok(haversineMeters(result.value, offsetPosition(origin, 3, 0)) < 0.01)
  assert.ok(result.horizontalSigmaM >= 3)
  assert.equal(buffer.at(3000)?.method, 'exact')
  assert.equal(buffer.at(6000), undefined)
})

test('projection requires fresh motion and grows horizontal uncertainty', () => {
  const buffer = new PositionBuffer(normalizeConfig({}))
  buffer.add(fix(1000, 0))
  const result = buffer.at(3000, number(3, 3000), number(Math.PI / 2, 3000), true)!
  assert.ok(haversineMeters(result.value, offsetPosition(origin, 6, 0)) < 0.01)
  assert.ok(result.horizontalSigmaM > 6)
  assert.equal(buffer.at(3000, number(3, 0), number(Math.PI / 2, 3000), true), undefined)
  assert.equal(buffer.at(3000, number(3, 3000), undefined, true), undefined)
  assert.equal(buffer.at(3001, number(0, 3001), undefined, true), undefined)
})

test('source switches and gaps reset interpolation; late fixes do not rewind it', () => {
  const buffer = new PositionBuffer(normalizeConfig({}))
  buffer.add(fix(1000, 0)); assert.equal(buffer.add(fix(3000, 10, 'other')), true)
  assert.equal(buffer.at(2000), undefined)
  buffer.add(fix(2000, 1000))
  assert.ok(haversineMeters(buffer.at(3000)!.value, offsetPosition(origin, 10, 0)) < 0.01)
  assert.equal(buffer.add(fix(400000, 20, 'other')), true)
  assert.equal(buffer.at(3000), undefined)
})

test('interpolation follows the short path across the antimeridian', () => {
  const buffer = new PositionBuffer(normalizeConfig({}))
  buffer.add({ value: { latitude: 0, longitude: 179.999 }, timestampMs: 1000, source: 'gps' })
  buffer.add({ value: { latitude: 0, longitude: -179.999 }, timestampMs: 3000, source: 'gps' })
  assert.ok(Math.abs(buffer.at(2000)!.value.longitude) > 179.99)
})
