import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observedContours as generateContours } from '../src/noaa-csb-contours'
import { WaterBoundary } from '../src/csb-water-mask'
import { mercatorToLonLat, tileMercatorBounds } from '../src/geo'

function observedContours(soundings: Parameters<typeof generateContours>[0], z: number, x: number, y: number) {
  const water = WaterBoundary.parse({ version: 1, z, x, y, extent: 4096, source: 'test', revision: '1',
    polygons: [[[[-1,-1],[4097,-1],[4097,4097],[-1,4097],[-1,-1]]]] }, z, x, y)
  return generateContours(soundings, z, x, y, water)
}

test('missing water boundaries suppress inferred contours', () => {
  assert.deepEqual(generateContours([sounding(0,0,2,'a'), sounding(10,0,30,'b')], 14, 8192, 8191), [])
})

test('water mask excludes shore crossings and tiny enclosed islands, not just endpoints', () => {
  const mask = { version: 1, z: 14, x: 0, y: 0, extent: 4096, source: 'test', revision: '1',
    polygons: [[[[0,0],[2000,0],[2000,4096],[0,4096],[0,0]],
      [[100,100],[110,100],[110,110],[100,110],[100,100]]]] }
  const water = WaterBoundary.parse(mask, 14, 0, 0)!
  assert.ok(water)
  assert.equal(water.containsCell(200,200,300,300), true)
  assert.equal(water.containsCell(1900,200,2100,300), false)
  assert.equal(water.containsCell(2100,200,2200,300), false)
  assert.equal(water.containsCell(90,90,120,120), false)
  assert.equal(water.containsCell(102,102,108,108), false)
  assert.equal(water.containsCell(1900,200,2000,300), false)
  assert.equal(WaterBoundary.parse(mask, 15, 0, 0), undefined)
  assert.equal(WaterBoundary.parse({ ...mask, polygons: [[[[0,0],[1,0],[0,1]]]] }, 14,0,0), undefined)
})

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
  assert.equal(observedContours([point, sounding(10, 0, 10, 'two')], 6, 32, 31).length, 0)
})

test('overview contours retain observed underwater shape through zoom eight', () => {
  for (const z of [7, 8, 9, 10, 11]) {
    const bounds = tileMercatorBounds(z, 2 ** (z - 1), 2 ** (z - 1))
    const span = bounds.maxX - bounds.minX
    const points = Array.from({length: 257}, (_, i) => sounding(
      bounds.minX + span * i / 256, bounds.maxY - span / 2, 2 + i / 2, String(i)))
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
