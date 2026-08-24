import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bboxToCellRange,
  hexCellCenter,
  hexCellForMercator,
  hexCellMercatorBounds,
  hexCellVertices
} from '../src/geo'

test('pointy hex centers round-trip through axial cell selection', () => {
  const cellMeters = 5
  const cells = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -4, y: 9 },
    { x: 2_000_000, y: -750_000 }
  ]
  for (const cell of cells) {
    const center = hexCellCenter(cell.x, cell.y, cellMeters)
    assert.deepEqual(hexCellForMercator(center.x, center.y, cellMeters), cell)
  }
})

test('six axial neighbors touch the center hex without overlapping its center', () => {
  const cellMeters = 10
  const origin = hexCellVertices(0, 0, cellMeters)
  const neighbors = [
    [1, 0],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [0, -1],
    [1, -1]
  ] as const
  for (const [x, y] of neighbors) {
    const vertices = hexCellVertices(x, y, cellMeters)
    const shared = vertices.filter((candidate) =>
      origin.some(
        (point) => Math.abs(point.x - candidate.x) < 1e-9 && Math.abs(point.y - candidate.y) < 1e-9
      )
    )
    assert.equal(shared.length, 2)
  }
})

test('hex bounds and bbox range include intersecting cell geometry', () => {
  const bounds = hexCellMercatorBounds(3, -2, 5)
  const range = bboxToCellRange(bounds, 5)
  assert.ok(range.minCellX <= 3 && range.maxCellX >= 3)
  assert.ok(range.minCellY <= -2 && range.maxCellY >= -2)
})
