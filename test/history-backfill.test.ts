import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context, Path, Timestamp, history } from '@signalk/server-api'
import { alignHistoryRows } from '../src/history-backfill'

const DEPTH_PATH = 'environment.depth.belowKeel'
const TIDE_PATH = 'environment.tide.heightNow'
const SOG_PATH = 'navigation.speedOverGround'
const POSITION_TOLERANCE_MS = 2_000
const TIDE_TOLERANCE_MS = 180_000

test('aligns sparse position, depth, tide, and SOG responses by timestamp', () => {
  const positions = response('navigation.position', [
    ['2026-08-01T00:00:00.000Z', [-122.4, 37.8]],
    ['2026-08-01T00:00:02.000Z', [-122.402, 37.802]]
  ])
  const depth = response(DEPTH_PATH, [
    ['2026-08-01T00:00:01.000Z', 4.5],
    ['2026-08-01T00:00:02.000Z', 4.6]
  ])
  // One-minute tide samples with a physically paced rise: 0.01 m per minute
  // is 0.01 m/min, well inside the plausibility bound.
  const tide = response(TIDE_PATH, [
    ['2026-08-01T00:00:00.000Z', 0.8],
    ['2026-08-01T00:00:01.000Z', 0.8],
    ['2026-08-01T00:00:02.000Z', 0.8]
  ])
  const sog = response(SOG_PATH, [['2026-08-01T00:00:01.000Z', 1.2]])

  assert.deepEqual(
    alignHistoryRows(
      positions,
      depth,
      tide,
      sog,
      POSITION_TOLERANCE_MS,
      TIDE_TOLERANCE_MS,
      DEPTH_PATH
    ),
    [
      ['2026-08-01T00:00:01.000Z', [-122.4, 37.8], 4.5, 0.8, 1.2],
      ['2026-08-01T00:00:02.000Z', [-122.402, 37.802], 4.6, 0.8, 1.2]
    ]
  )
})

test('does not attach a stale position to a measurement', () => {
  const positions = response('navigation.position', [
    ['2026-08-01T00:00:00.000Z', [-122.4, 37.8]]
  ])
  const depth = response(DEPTH_PATH, [['2026-08-01T00:00:10.000Z', 4.5]])
  const tide = response(TIDE_PATH, [['2026-08-01T00:00:10.000Z', 0.8]])

  assert.deepEqual(
    alignHistoryRows(
      positions,
      depth,
      tide,
      undefined,
      5_000,
      TIDE_TOLERANCE_MS,
      DEPTH_PATH
    ),
    []
  )
})

test('does not produce soundings when the tide is missing beyond tolerance', () => {
  const positions = response('navigation.position', [
    ['2026-08-01T00:00:00.000Z', [-122.4, 37.8]]
  ])
  const depth = response(DEPTH_PATH, [['2026-08-01T00:00:01.000Z', 4.5]])
  const tide = response(TIDE_PATH, [['2026-08-01T01:00:01.000Z', 0.8]])

  assert.deepEqual(
    alignHistoryRows(
      positions,
      depth,
      tide,
      undefined,
      POSITION_TOLERANCE_MS,
      TIDE_TOLERANCE_MS,
      DEPTH_PATH
    ),
    []
  )
})

test('aligns history using a configured position path', () => {
  const positionPath = 'navigation.gnss.position'
  const positions = response(positionPath, [
    ['2026-08-01T00:00:00.000Z', { latitude: 37.8, longitude: -122.4 }]
  ])
  const depth = response(DEPTH_PATH, [['2026-08-01T00:00:00.000Z', 4.5]])
  const tide = response(TIDE_PATH, [['2026-08-01T00:00:00.000Z', 0.8]])

  assert.deepEqual(
    alignHistoryRows(
      positions,
      depth,
      tide,
      undefined,
      POSITION_TOLERANCE_MS,
      TIDE_TOLERANCE_MS,
      DEPTH_PATH,
      positionPath
    ),
    [['2026-08-01T00:00:00.000Z', { latitude: 37.8, longitude: -122.4 }, 4.5, 0.8, undefined]]
  )
})

test('truncates a corrupt tide tail that jumps faster than a physical tide', () => {
  // Reproduces the observed provider corruption: the multi-path merge emitted a
  // tide series that falls to low water, then jumps to the next high within a
  // couple of minutes (a 0.77 m jump in 2 s implies 23 m/min; real tides run
  // centimeters per minute), then goes silent.
  const positions = response('navigation.position', [
    ['2026-08-01T00:00:31.000Z', [-122.4, 37.8]],
    ['2026-08-01T00:09:30.000Z', [-122.4, 37.8]]
  ])
  const depth = response(DEPTH_PATH, [
    ['2026-08-01T00:00:30.000Z', 4.5],
    ['2026-08-01T00:09:30.000Z', 4.6]
  ])
  const tide = response(TIDE_PATH, [
    ['2026-08-01T00:00:00.000Z', 0.8],
    ['2026-08-01T00:00:40.000Z', 0.79],
    ['2026-08-01T00:00:42.000Z', 1.378],
    ['2026-08-01T00:00:50.000Z', 1.378],
    ['2026-08-01T00:09:35.000Z', 1.378]
  ])

  const rows = alignHistoryRows(
    positions,
    depth,
    tide,
    undefined,
    POSITION_TOLERANCE_MS,
    TIDE_TOLERANCE_MS,
    DEPTH_PATH
  )
  // The 00:09:30 depth row would have joined the corrupt 1.378 sample at
  // 00:09:35 without the filter; with the corrupt tail truncated there is no
  // tide left within tolerance, so it produces no sounding at all rather than
  // a sounding built on a phantom tide.
  assert.deepEqual(rows, [
    ['2026-08-01T00:00:30.000Z', [-122.4, 37.8], 4.5, 0.79, undefined]
  ])
})

test('keeps a real tide series that rises within physical bounds', () => {
  // Bay of Fundy class spring tide: ~0.04 m/min sustained rise must survive.
  const positions = response('navigation.position', [
    ['2026-08-01T00:30:00.000Z', [-122.4, 37.8]]
  ])
  const depth = response(DEPTH_PATH, [['2026-08-01T00:30:00.000Z', 4.5]])
  const tide = response(TIDE_PATH, [
    ['2026-08-01T00:00:00.000Z', 0.8],
    ['2026-08-01T00:10:00.000Z', 1.2],
    ['2026-08-01T00:20:00.000Z', 1.6],
    ['2026-08-01T00:30:00.000Z', 2.0]
  ])

  const rows = alignHistoryRows(
    positions,
    depth,
    tide,
    undefined,
    POSITION_TOLERANCE_MS,
    TIDE_TOLERANCE_MS,
    DEPTH_PATH
  )
  assert.deepEqual(rows, [['2026-08-01T00:30:00.000Z', [-122.4, 37.8], 4.5, 2.0, undefined]])
})

test('joins sparse tide buckets to dense depth rows within the tide tolerance', () => {
  // The tide is recorded once per minute while depth arrives every second.
  const positions = response('navigation.position', [
    ['2026-08-01T00:00:00.000Z', [-122.4, 37.8]]
  ])
  const depth = response(DEPTH_PATH, [
    ['2026-08-01T00:00:00.000Z', 4.5],
    ['2026-08-01T00:00:01.000Z', 4.5],
    ['2026-08-01T00:00:02.000Z', 4.5]
  ])
  const tide = response(TIDE_PATH, [['2026-08-01T00:00:00.000Z', 0.8]])

  const rows = alignHistoryRows(
    positions,
    depth,
    tide,
    undefined,
    POSITION_TOLERANCE_MS,
    TIDE_TOLERANCE_MS,
    DEPTH_PATH
  )
  assert.equal(rows.length, 3)
  for (const row of rows) assert.equal(row[3], 0.8)
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