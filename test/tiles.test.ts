import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { cellForPosition, hexCellCenter, mercatorToLonLat } from '../src/geo'
import { BathymetryStore } from '../src/store'
import { ProjectionUnavailableError, TileRenderer } from '../src/tiles'
import { sounding } from './helpers'

test('renderer emits joined hex PNG tiles, labels depth, and requires fresh projected tide', (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-tile-test-'))
  const config = normalizeConfig({
    baseCellMeters: 10,
    minZoom: 0,
    dangerUnderKeelM: 0.8,
    showDepthLabels: true,
    depthLabelMinZoom: 19
  })
  const store = new BathymetryStore(join(directory, 'test.sqlite'), config)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const input = sounding(config)
  store.ingest([input])
  const { x, y } = webTile(input.latitude, input.longitude, 16)

  const noTide = new TileRenderer(store, config, () => undefined)
  const datum = noTide.render({ z: 16, x, y, layer: 'depth', mode: 'datum', atMs: Date.now() })
  assert.equal(datum.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.ok(datum.cellCount >= 1)
  assert.equal(datum.labelCount, 0)
  assert.throws(
    () => noTide.render({ z: 16, x, y, layer: 'depth', mode: 'water', atMs: Date.now() }),
    ProjectionUnavailableError
  )

  const withTide = new TileRenderer(store, config, (atMs) => ({
    heightM: 1.2,
    sigmaM: 0.2,
    datum: config.targetDatum,
    stationId: 'test',
    stationName: 'Test',
    source: 'test',
    method: 'predicted',
    timestampMs: atMs,
    stale: false
  }))
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
