import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observedContours } from '../src/noaa-csb-contours'
import { mercatorToLonLat, tileMercatorBounds } from '../src/geo'

function sounding(x: number, y: number, depthM: number, uniqueId: string) {
  return {
    ...mercatorToLonLat(x, y),
    depthM,
    fileUuid: 'survey',
    uniqueId,
    observedAtMs: 0,
    platform: '',
    provider: '',
    instrument: ''
  }
}

test('bounded interpolation derives contours from sparse vessel tracks at regional zoom', () => {
  const bounds = tileMercatorBounds(14, 2621, 6318)
  const span = bounds.maxX - bounds.minX
  const points = Array.from({ length: 20 }, (_, index) =>
    sounding(
      bounds.minX + span * (0.2 + index * 0.03),
      bounds.maxY - span * (0.35 + index * 0.005),
      2 + index * 1.8,
      String(index)
    )
  )
  const contours = observedContours(points, 14, 2621, 6318)
  assert.ok(contours.length > 0)
  assert.ok(contours.some((contour) => contour.depth === 20))
  assert.ok(contours.every((contour) => contour.ring.length === 2))
  assert.ok(contours.every((contour) => contour.interpolationRadiusM > 0))
})

test('contours stay disabled at world zoom and require multiple observations', () => {
  const point = sounding(0, 0, 5, 'one')
  assert.equal(observedContours([point], 15, 16384, 16383).length, 0)
  assert.equal(observedContours([point, sounding(10, 0, 10, 'two')], 7, 64, 63).length, 0)
})

test('overview contours retain observed underwater shape through zoom eight', () => {
  for (const z of [8, 9, 10, 11]) {
    const bounds = tileMercatorBounds(z, 2 ** (z - 1), 2 ** (z - 1))
    const span = bounds.maxX - bounds.minX
    const points = Array.from({length: 129}, (_, i) => sounding(
      bounds.minX + span * i / 128, bounds.maxY - span / 2, 2 + i, String(i)))
    const contours = observedContours(points, z, 2 ** (z - 1), 2 ** (z - 1))
    assert.ok(contours.length > 0, `zoom ${z}`)
    assert.ok(contours.every(c => c.interpolationRadiusM <= 3000))
  }
})

test('bounded interpolation does not bridge distant observations', () => {
  const bounds = tileMercatorBounds(15, 5242, 12637)
  const span = bounds.maxX - bounds.minX
  const points = [
    sounding(bounds.minX + span * 0.05, bounds.maxY - span * 0.05, 2, 'one'),
    sounding(bounds.minX + span * 0.95, bounds.maxY - span * 0.95, 100, 'two')
  ]
  assert.equal(observedContours(points, 15, 5242, 12637).length, 0)
})
