import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context, Path, Timestamp, history } from '@signalk/server-api'
import { alignHistoryRows } from '../src/history-backfill'

const DEPTH_PATH = 'environment.depth.belowKeel'

test('aligns sparse position and measurement responses by timestamp', () => {
  const positions = response(
    ['navigation.position'],
    [
      ['2026-08-01T00:00:00.000Z', [-122.4, 37.8]],
      ['2026-08-01T00:00:02.000Z', [-122.402, 37.802]]
    ]
  )
  const measurements = response(
    ['navigation.speedOverGround', DEPTH_PATH, 'environment.tide.heightNow'],
    [
      ['2026-08-01T00:00:01.000Z', 1.2, 4.5, 0.8],
      ['2026-08-01T00:00:02.000Z', 1.3, 4.6, 0.8]
    ]
  )

  assert.deepEqual(alignHistoryRows(positions, measurements, 2_000, DEPTH_PATH), [
    ['2026-08-01T00:00:01.000Z', [-122.4, 37.8], 4.5, 0.8, 1.2],
    ['2026-08-01T00:00:02.000Z', [-122.402, 37.802], 4.6, 0.8, 1.3]
  ])
})

test('does not attach a stale position to a measurement', () => {
  const positions = response('navigation.position', [
    ['2026-08-01T00:00:00.000Z', [-122.4, 37.8]]
  ])
  const measurements = response([DEPTH_PATH, 'environment.tide.heightNow'], [
    ['2026-08-01T00:00:10.000Z', 4.5, 0.8]
  ])

  assert.deepEqual(alignHistoryRows(positions, measurements, 5_000, DEPTH_PATH), [])
})

test('aligns history using a configured position path', () => {
  const positionPath = 'navigation.gnss.position'
  const positions = response(positionPath, [
    ['2026-08-01T00:00:00.000Z', { latitude: 37.8, longitude: -122.4 }]
  ])
  const measurements = response([DEPTH_PATH, 'environment.tide.heightNow'], [
    ['2026-08-01T00:00:00.000Z', 4.5, 0.8]
  ])

  assert.deepEqual(
    alignHistoryRows(positions, measurements, 2_000, DEPTH_PATH, positionPath),
    [['2026-08-01T00:00:00.000Z', { latitude: 37.8, longitude: -122.4 }, 4.5, 0.8, undefined]]
  )
})

function response(
  paths: string | string[],
  data: Array<[string, ...unknown[]]>
): history.ValuesResponse {
  const list = typeof paths === 'string' ? [paths] : paths
  return {
    context: 'vessels.self' as Context,
    range: {
      from: '2026-08-01T00:00:00.000Z' as Timestamp,
      to: '2026-08-01T00:01:00.000Z' as Timestamp
    },
    values: list.map((path) => ({ path: path as Path, method: 'average' as const })),
    data: data.map(([timestamp, ...values]) => [timestamp as Timestamp, ...values])
  }
}
