import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { cellForPosition, hexCellCenter, mercatorToLonLat } from '../src/geo'
import { BathymetryStore } from '../src/store'
import {
  aggregateOverviewCells,
  clearanceColor,
  confidenceBadgeColor,
  confidenceLabelStyle,
  depthColor,
  formatDepth,
  overviewCellMeters,
  ProjectionUnavailableError,
  safeBlueWaterDepth,
  TileRenderer
} from '../src/tiles'
import { sounding } from './helpers'
import { METRIC_DEPTH_UNITS, type DepthDisplayUnits } from '../src/depth-units'
import type { SurfaceCell } from '../src/types'

test('depth labels conservatively round down at ten display units and above', () => {
  assert.equal(formatDepth(9.89, 1), '9.8')
  assert.equal(formatDepth(10, 1), '10')
  assert.equal(formatDepth(10.9, 1), '10')
  assert.equal(formatDepth(-1.21, 1), '-1.3')
  assert.equal(formatDepth(-12.4, 1), '-13')
})

test('confidence badges progress from red through amber to green', () => {
  const low = confidenceBadgeColor(0.25)
  const medium = confidenceBadgeColor(0.6)
  const high = confidenceBadgeColor(0.9)
  assert.ok(low[0] > low[1] * 2)
  assert.ok(medium[0] > medium[2] * 8 && medium[1] > medium[2] * 8)
  assert.ok(high[1] > high[0] * 2)
  assert.deepEqual(confidenceBadgeColor(-1), confidenceBadgeColor(0))
  assert.deepEqual(confidenceBadgeColor(2), confidenceBadgeColor(1))
})

test('safe depth backgrounds use a light-to-cobalt blue scale after three drafts', () => {
  const draftM = 1.5
  const dangerM = 0.75
  const blueStart = safeBlueWaterDepth(draftM, dangerM)
  assert.equal(blueStart, 4.5)
  assert.deepEqual(depthColor(blueStart, draftM + dangerM, blueStart), [216, 243, 255])
  assert.deepEqual(depthColor(blueStart * 8, draftM + dangerM, blueStart), [18, 70, 171])
  assert.deepEqual(clearanceColor(blueStart - draftM, dangerM, draftM), [216, 243, 255])
  assert.deepEqual(clearanceColor((blueStart - draftM) * 10, dangerM, draftM), [18, 70, 171])
})

test('strong confidence slugs fade away on safe blue depth cells', () => {
  assert.equal(confidenceLabelStyle(0.25, true).alpha, 242)
  assert.equal(confidenceLabelStyle(0.6, true).alpha, 242)
  assert.ok(confidenceLabelStyle(0.8, true).alpha > 0)
  assert.equal(confidenceLabelStyle(1, true).alpha, 0)
  assert.equal(confidenceLabelStyle(1, false).alpha, 242)
  assert.ok(confidenceLabelStyle(1, false).background[1] > 0)
})

test('overview uses larger world-aligned hexes and the shallowest conservative cell', () => {
  assert.equal(overviewCellMeters(5, 22), 5)
  assert.equal(overviewCellMeters(5, 24), 5)
  assert.equal(overviewCellMeters(5, 21), 5)
  assert.equal(overviewCellMeters(5, 20), 5)
  assert.equal(overviewCellMeters(5, 19), 10)
  assert.equal(overviewCellMeters(5, 18), 20)
  assert.equal(overviewCellMeters(5, 17), 40)
  assert.equal(overviewCellMeters(5, 16), 80)
  assert.equal(overviewCellMeters(5, 15), 160)
  assert.equal(overviewCellMeters(5, 14), 320)
  assert.equal(overviewCellMeters(5, 13), 640)
  assert.equal(overviewCellMeters(5, 8), 640)
  assert.equal(overviewCellMeters(5, 19, 0.5), 5)
  assert.equal(overviewCellMeters(5, 18, 0.5), 10)
  assert.equal(overviewCellMeters(5, 19, 2), 20)
  assert.equal(overviewCellMeters(5, 20, 4), 20)
  assert.equal(overviewCellMeters(5, 20, 0.5), 5)

  const common: SurfaceCell = {
    cellX: 0,
    cellY: 0,
    datum: 'MLLW',
    robustDepthM: 5,
    renderDepthM: 5,
    conservativeDepthM: 4.5,
    verticalSigmaM: 0.3,
    confidence: 0.9,
    soundingCount: 2,
    observationCount: 2,
    passCount: 1,
    sourceCount: 1,
    oldestAtMs: 1,
    newestAtMs: 2,
    changeState: 'stable',
    updatedAtMs: 2
  }
  const shallow: SurfaceCell = {
    ...common,
    cellX: 1,
    conservativeDepthM: 3.2,
    soundingCount: 3,
    observationCount: 3,
    newestAtMs: 3
  }
  const overview = aggregateOverviewCells([common, shallow], 5, 20, 'datum', undefined)
  assert.equal(overview.length, 1)
  assert.equal(overview[0]?.conservativeDepthM, 3.2)
  assert.equal(overview[0]?.soundingCount, 5)
  assert.ok((overview[0]?.confidence ?? 1) < 0.55)
})

test('renderer emits joined hex PNG tiles, labels depth, and requires fresh projected tide', (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-tile-test-'))
  const config = normalizeConfig({
    baseCellMeters: 10,
    minZoom: 0,
    dangerUnderKeelM: 0.8,
    showDepthLabels: true
  })
  const store = new BathymetryStore(join(directory, 'test.sqlite'), config)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const input = sounding(config)
  store.ingest([input])
  const { x, y } = webTile(input.latitude, input.longitude, 16)

  const noTide = new TileRenderer(store, config, () => undefined, () => METRIC_DEPTH_UNITS)
  const datum = noTide.render({ z: 16, x, y, layer: 'depth', mode: 'datum', atMs: Date.now() })
  assert.equal(datum.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.ok(datum.cellCount >= 1)
  assert.equal(datum.cellMeters, 160)
  assert.ok(datum.labelCount >= 1)
  assert.throws(
    () => noTide.render({ z: 16, x, y, layer: 'depth', mode: 'water', atMs: Date.now() }),
    ProjectionUnavailableError
  )

  const withTide = new TileRenderer(
    store,
    config,
    (atMs) => ({
      heightM: 1.2,
      sigmaM: 0.2,
      datum: config.targetDatum,
      stationId: 'test',
      stationName: 'Test',
      source: 'test',
      method: 'predicted',
      timestampMs: atMs,
      stale: false
    }),
    () => METRIC_DEPTH_UNITS
  )
  const water = withTide.render({ z: 16, x, y, layer: 'depth', mode: 'water', atMs: Date.now() })
  assert.equal(water.projection?.heightM, 1.2)
  assert.notDeepEqual(water.png, datum.png)

  const cell = cellForPosition(input, config.baseCellMeters)
  const cellCenter = hexCellCenter(cell.x, cell.y, config.baseCellMeters)
  const labelPosition = mercatorToLonLat(cellCenter.x, cellCenter.y)
  const highZoom = webTile(labelPosition.latitude, labelPosition.longitude, 20)
  const labelledDatum = noTide.render({
    z: 20,
    x: highZoom.x,
    y: highZoom.y,
    layer: 'depth',
    mode: 'datum',
    atMs: Date.now()
  })
  const labelledWater = withTide.render({
    z: 20,
    x: highZoom.x,
    y: highZoom.y,
    layer: 'depth',
    mode: 'water',
    atMs: Date.now()
  })
  assert.ok(labelledDatum.labelCount >= 1)
  assert.equal(labelledWater.labelCount, labelledDatum.labelCount)
  assert.notDeepEqual(labelledWater.png, labelledDatum.png)

  const feet: DepthDisplayUnits = {
    ...METRIC_DEPTH_UNITS,
    targetUnit: 'foot',
    symbol: 'ft',
    metersToDisplayFactor: 3.280839895013124
  }
  const feetRenderer = new TileRenderer(store, config, () => undefined, () => feet)
  const labelledFeet = feetRenderer.render({
    z: 20,
    x: highZoom.x,
    y: highZoom.y,
    layer: 'depth',
    mode: 'datum',
    atMs: Date.now()
  })
  assert.ok(labelledFeet.labelCount >= 1)
  assert.notDeepEqual(labelledFeet.png, labelledDatum.png)
})

function webTile(latitude: number, longitude: number, zoom: number): { x: number; y: number } {
  const count = 2 ** zoom
  const latitudeRad = (latitude * Math.PI) / 180
  return {
    x: Math.floor(((longitude + 180) / 360) * count),
    y: Math.floor(
      ((1 - Math.log(Math.tan(latitudeRad) + 1 / Math.cos(latitudeRad)) / Math.PI) / 2) *
        count
    )
  }
}
