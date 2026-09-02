import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { cellForPosition, hexCellCenter, mercatorToLonLat } from '../src/geo'
import { BathymetryStore } from '../src/store'
import {
  BATHYMETRY_MVT_LAYER,
  BATHYMETRY_MVT_SOUNDINGS_LAYER,
  VectorTileRenderer
} from '../src/vector-tiles'
import { sounding } from './helpers'

test('vector renderer emits queryable S-57 DEPARE cells with quality metadata', (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-mvt-test-'))
  const config = normalizeConfig({
    baseCellMeters: 10,
    minZoom: 0,
    maxZoom: 24,
    displayDepth: 'conservative',
    depthLabelRelativeSize: 1.4
  })
  const store = new BathymetryStore(join(directory, 'test.sqlite'), config)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const input = sounding(config, {
    datumDepthM: 6.25,
    rawDepthM: 5.75,
    verticalSigmaM: 0.4,
    sampleCount: 12,
    aggregationKind: 'stationary_window'
  })
  store.ingest([input])
  const z = 20
  const tile = tileForPosition(input.longitude, input.latitude, z)
  const rendered = new VectorTileRenderer(store, config, () => undefined).render({
    z,
    ...tile,
    mode: 'datum',
    atMs: input.observedAtMs
  })

  assert.ok(rendered.cellCount > 0)
  assert.equal(rendered.cellMeters, 10)
  const decoded = decodeTile(rendered.tile)
  assert.equal(decoded.name, BATHYMETRY_MVT_LAYER)
  assert.equal(decoded.version, 2)
  assert.equal(decoded.extent, 4096)
  assert.ok(decoded.features.length > 0)
  const cell = decoded.features.find(
    (feature) => feature.properties.BATHY_CELL_X !== undefined
  )
  assert.ok(cell)
  assert.equal(cell.type, 3)
  assert.ok(cell.geometry.length >= 10)
  assert.equal(cell.properties.BATHYMETRY_PROVIDER, 'signalk-bathymetry')
  assert.equal(cell.properties.BATHY_MODE, 'datum')
  assert.equal(cell.properties.BATHY_DATUM, config.targetDatum)
  assert.equal(cell.properties.BATHY_SOUNDING_COUNT, 12)
  assert.equal(cell.properties.BATHY_OBSERVATION_COUNT, 1)
  assert.equal(cell.properties.BATHY_CHANGE_STATE, 'stable')
  assert.equal(cell.properties.BATHY_SHOW_DEPTH_LABELS, true)
  assert.equal(cell.properties.BATHY_LABEL_RELATIVE_SIZE, 1.4)
  assert.equal(cell.properties.BATHY_LABEL, '5.5')
  assert.equal(cell.properties.BATHY_LABEL_UNIT, 'm')
  assert.ok(Number(cell.properties.BATHY_CONFIDENCE) <= 0.25)
  assert.match(String(cell.properties.BATHY_CONFIDENCE_REASONS), /single_observation/)
  assert.equal(cell.properties.DRVAL1, cell.properties.BATHY_DEPTH_M)
  assert.equal(cell.properties.DRVAL2, cell.properties.BATHY_DEPTH_M)
  assert.deepEqual(layerNames(rendered.tile), [
    BATHYMETRY_MVT_LAYER,
    BATHYMETRY_MVT_SOUNDINGS_LAYER
  ])
})

test('water MVT uses the conservative tide projection and retains tide quality', (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-mvt-water-test-'))
  const config = normalizeConfig({
    baseCellMeters: 10,
    minZoom: 0,
    maxZoom: 24,
    displayDepth: 'conservative'
  })
  const store = new BathymetryStore(join(directory, 'test.sqlite'), config)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const input = sounding(config, { datumDepthM: 5, verticalSigmaM: 0.3 })
  store.ingest([input])
  const projection = {
    heightM: 1.2,
    sigmaM: 0.2,
    datum: config.targetDatum,
    stationId: '9414290',
    stationName: 'San Francisco',
    source: 'test',
    method: 'predicted' as const,
    timestampMs: input.observedAtMs,
    stale: false
  }
  const z = 20
  const tile = tileForPosition(input.longitude, input.latitude, z)
  const rendered = new VectorTileRenderer(store, config, () => projection).render({
    z,
    ...tile,
    mode: 'water',
    atMs: input.observedAtMs
  })
  const feature = decodeTile(rendered.tile).features[0]
  assert.ok(feature)
  assert.equal(feature.properties.BATHY_MODE, 'water')
  assert.equal(feature.properties.BATHY_TIDE_HEIGHT_M, 1.2)
  assert.equal(feature.properties.BATHY_TIDE_STATION, 'San Francisco')
  assert.ok(Number(feature.properties.BATHY_DEPTH_M) < 6.2)
})

test('vector renderer applies a supported zoom-relative cell-size scale', (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-mvt-scale-test-'))
  const config = normalizeConfig({ baseCellMeters: 10, minZoom: 0, maxZoom: 24 })
  const store = new BathymetryStore(join(directory, 'test.sqlite'), config)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const input = sounding(config)
  store.ingest([input])
  const renderer = new VectorTileRenderer(store, config, () => undefined)
  const tile = tileForPosition(input.longitude, input.latitude, 19)

  assert.equal(
    renderer.render({ z: 19, ...tile, mode: 'datum', atMs: input.observedAtMs, cellSizeScale: 0.5 })
      .cellMeters,
    10
  )
  assert.equal(
    renderer.render({
      z: 19,
      ...tile,
      mode: 'datum',
      atMs: input.observedAtMs,
      cellSizeScale: 0.75
    })
      .cellMeters,
    15
  )
})

test('predicted display depth publishes the best estimate without the safety margin', (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-mvt-predicted-test-'))
  const config = normalizeConfig({
    baseCellMeters: 10,
    minZoom: 0,
    maxZoom: 24,
    displayDepth: 'predicted'
  })
  const store = new BathymetryStore(join(directory, 'test.sqlite'), config)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const input = sounding(config, {
    datumDepthM: 6.25,
    rawDepthM: 5.75,
    verticalSigmaM: 0.4,
    sampleCount: 12,
    aggregationKind: 'stationary_window'
  })
  store.ingest([input])
  const z = 20
  const tile = tileForPosition(input.longitude, input.latitude, z)
  const rendered = new VectorTileRenderer(store, config, () => undefined).render({
    z,
    ...tile,
    mode: 'datum',
    atMs: input.observedAtMs
  })
  const predicted = decodeTile(rendered.tile).features.find(
    (feature) => feature.properties.BATHY_CELL_X !== undefined
  )
  assert.ok(predicted)
  assert.equal(predicted.properties.BATHY_DISPLAY_KIND, 'predicted')
  // The primary depth is the render (best-estimate) depth, not the conservative
  // bound, and both facts still travel separately.
  assert.equal(predicted.properties.BATHY_DEPTH_M, predicted.properties.BATHY_RENDER_DEPTH_M)
  assert.ok(
    Number(predicted.properties.BATHY_CONSERVATIVE_DEPTH_M) <
      Number(predicted.properties.BATHY_RENDER_DEPTH_M)
  )
  assert.equal(predicted.properties.DRVAL1, predicted.properties.BATHY_DEPTH_M)

  // The explicitly selected conservative portrayal keeps the shallow-biased primary depth.
  const safeConfig = normalizeConfig({
    baseCellMeters: 10,
    minZoom: 0,
    maxZoom: 24,
    displayDepth: 'conservative'
  })
  const safeStore = new BathymetryStore(join(directory, 'safe.sqlite'), safeConfig)
  t.after(() => safeStore.close())
  safeStore.ingest([input])
  const safeRendered = new VectorTileRenderer(safeStore, safeConfig, () => undefined).render({
    z,
    ...tile,
    mode: 'datum',
    atMs: input.observedAtMs
  })
  const safe = decodeTile(safeRendered.tile).features.find(
    (feature) => feature.properties.BATHY_CELL_X !== undefined
  )
  assert.ok(safe)
  assert.equal(safe.properties.BATHY_DISPLAY_KIND, 'conservative')
  assert.equal(safe.properties.BATHY_DEPTH_M, safe.properties.BATHY_CONSERVATIVE_DEPTH_M)
})

test('overview aggregation reports coverage without capping member confidence', (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-mvt-coverage-test-'))
  const config = normalizeConfig({ baseCellMeters: 5, minZoom: 0, maxZoom: 24 })
  const store = new BathymetryStore(join(directory, 'test.sqlite'), config)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  // Four adjacent 5 m base cells whose centers round into the same 15 m overview
  // cell at zoom 18, measured across three passes and two sources each.
  const children: Array<{ x: number; y: number; datumDepthM: number }> = [
    { x: 0, y: 0, datumDepthM: 5 },
    { x: 1, y: 0, datumDepthM: 5 },
    { x: 0, y: 1, datumDepthM: 5 },
    { x: 1, y: 1, datumDepthM: 3 }
  ]
  const now = Date.now()
  for (const child of children) {
    const center = hexCellCenter(child.x, child.y, 5)
    const position = mercatorToLonLat(center.x, center.y)
    const resolved = cellForPosition(position, 5)
    assert.ok(resolved.x === child.x && resolved.y === child.y, 'hex round trip')
    for (let pass = 0; pass < 3; pass += 1) {
      store.ingest([
        sounding(config, {
          latitude: position.latitude,
          longitude: position.longitude,
          observedAtMs: now - (pass + 1) * 86_400_000,
          ingestedAtMs: now,
          trackId: `track-${child.x}-${child.y}-${pass}`,
          passId: `pass-${child.x}-${child.y}-${pass}`,
          datumDepthM: child.datumDepthM,
          rawDepthM: child.datumDepthM,
          tideHeightM: 0,
          verticalSigmaM: 0.3,
          depthSource: pass === 0 ? 'n2k.sounder' : 'derived.plugin'
        })
      ])
    }
  }
  const renderer = new VectorTileRenderer(store, config, () => undefined)
  const tile = tileForPosition(0, 0, 18)
  const overview = renderer.render({ z: 18, ...tile, mode: 'datum', atMs: now, cellSizeScale: 1 })
  assert.equal(overview.cellMeters, 15)
  const overviewCell = decodeTile(overview.tile)
    .features.find(
      (feature) => feature.properties.BATHY_CELL_METERS === 15
    )
  assert.ok(overviewCell)
  assert.equal(overviewCell.properties.BATHY_CELL_X, 0)
  assert.equal(overviewCell.properties.BATHY_CELL_Y, 0)
  // The smaller supported overview cell still reports the measured coverage fraction.
  assert.ok(Number(overviewCell.properties.BATHY_COVERAGE) > 0)
  assert.ok(Number(overviewCell.properties.BATHY_COVERAGE) <= 1)
  // The confidence stays the controlling member's evidence quality instead of
  // being scaled by the 0.5 coverage-root the old aggregation applied.
  for (const child of children) {
    const center = hexCellCenter(child.x, child.y, 5)
    const position = mercatorToLonLat(center.x, center.y)
    const z20 = renderer.render({
      z: 20,
      ...tileForPosition(position.longitude, position.latitude, 20),
      mode: 'datum',
      atMs: now,
      cellSizeScale: 1
    })
    assert.equal(z20.cellMeters, 5)
    const base = decodeTile(z20.tile).features.find(
      (feature) =>
        feature.properties.BATHY_CELL_X === child.x &&
        feature.properties.BATHY_CELL_Y === child.y
    )
    assert.ok(base, `base cell ${child.x}:${child.y} missing`)
    // Base cells measure one grid position and carry no coverage fact.
    assert.equal(base.properties.BATHY_COVERAGE, undefined)
    if (child.datumDepthM === 3) {
      // The shallowest member controls the overview cell, so its confidence
      // must survive aggregation uncapped.
      assert.ok(Number(base.properties.BATHY_CONFIDENCE) > 0.5)
      assert.ok(
        Math.abs(
          Number(overviewCell.properties.BATHY_CONFIDENCE) -
            Number(base.properties.BATHY_CONFIDENCE)
        ) < 1e-9,
        'overview confidence must equal the controlling member confidence'
      )
    }
  }
})

test('a per-request display-depth choice overrides the configured estimate', (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-mvt-override-test-'))
  // The plugin is configured for the conservative safety bias; a chartplotter may still ask a
  // single request for the best estimate, and the reverse.
  const config = normalizeConfig({
    baseCellMeters: 10,
    minZoom: 0,
    maxZoom: 24,
    displayDepth: 'conservative'
  })
  const store = new BathymetryStore(join(directory, 'test.sqlite'), config)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const input = sounding(config, {
    datumDepthM: 6.25,
    rawDepthM: 5.75,
    verticalSigmaM: 0.4,
    sampleCount: 12,
    aggregationKind: 'stationary_window'
  })
  store.ingest([input])
  const renderer = new VectorTileRenderer(store, config, () => undefined)
  const z = 20
  const tile = tileForPosition(input.longitude, input.latitude, z)
  const renderOptions = { z, ...tile, mode: 'datum' as const, atMs: input.observedAtMs }

  const predicted = decodeTile(renderer.render({ ...renderOptions, displayDepth: 'predicted' }).tile)
    .features.find((feature) => feature.properties.BATHY_CELL_X !== undefined)
  assert.ok(predicted)
  assert.equal(predicted.properties.BATHY_DISPLAY_KIND, 'predicted')
  assert.equal(predicted.properties.BATHY_DEPTH_M, predicted.properties.BATHY_RENDER_DEPTH_M)
  assert.equal(predicted.properties.DRVAL1, predicted.properties.BATHY_DEPTH_M)

  const conservative = decodeTile(
    renderer.render({ ...renderOptions, displayDepth: 'conservative' }).tile
  ).features.find((feature) => feature.properties.BATHY_CELL_X !== undefined)
  assert.ok(conservative)
  assert.equal(conservative.properties.BATHY_DISPLAY_KIND, 'conservative')
  assert.equal(
    conservative.properties.BATHY_DEPTH_M,
    conservative.properties.BATHY_CONSERVATIVE_DEPTH_M
  )

  // Absent the option the configured default still decides: conservative here.
  const configured = decodeTile(renderer.render(renderOptions).tile).features.find(
    (feature) => feature.properties.BATHY_CELL_X !== undefined
  )
  assert.ok(configured)
  assert.equal(configured.properties.BATHY_DISPLAY_KIND, 'conservative')
})

function tileForPosition(longitude: number, latitude: number, z: number): { x: number; y: number } {
  const count = 2 ** z
  const latitudeRad = (latitude * Math.PI) / 180
  return {
    x: Math.floor(((longitude + 180) / 360) * count),
    y: Math.floor(
      ((1 - Math.log(Math.tan(latitudeRad) + 1 / Math.cos(latitudeRad)) / Math.PI) / 2) *
        count
    )
  }
}

interface DecodedFeature {
  type: number
  properties: Record<string, string | number | boolean>
  geometry: number[]
}

interface DecodedLayer {
  name: string
  version: number
  extent: number
  features: DecodedFeature[]
}

function decodeTile(tile: Uint8Array): DecodedLayer {
  const tileFields = fields(tile)
  const layerBytes = tileFields.find((field) => field.number === 3)?.bytes
  assert.ok(layerBytes)
  const layerFields = fields(layerBytes)
  const name = text(fieldBytes(layerFields, 1)[0])
  const version = Number(fieldVarints(layerFields, 15)[0])
  const extent = Number(fieldVarints(layerFields, 5)[0])
  const keys = fieldBytes(layerFields, 3).map(text)
  const values = fieldBytes(layerFields, 4).map(decodeValue)
  const features = fieldBytes(layerFields, 2).map((encoded) => {
    const featureFields = fields(encoded)
    const tags = packedVarints(fieldBytes(featureFields, 2)[0] ?? new Uint8Array())
    const properties: Record<string, string | number | boolean> = {}
    for (let index = 0; index < tags.length; index += 2) {
      const key = keys[Number(tags[index])]
      const value = values[Number(tags[index + 1])]
      if (key !== undefined && value !== undefined) properties[key] = value
    }
    return {
      type: Number(fieldVarints(featureFields, 3)[0]),
      properties,
      geometry: packedVarints(fieldBytes(featureFields, 4)[0] ?? new Uint8Array()).map(Number)
    }
  })
  return { name, version, extent, features }
}

function layerNames(tile: Uint8Array): string[] {
  return fieldBytes(fields(tile), 3).map((layer) => text(fieldBytes(fields(layer), 1)[0]))
}

interface Field {
  number: number
  wire: number
  varint?: bigint
  bytes?: Uint8Array
  fixed64?: Uint8Array
}

function fields(buffer: Uint8Array): Field[] {
  const result: Field[] = []
  let offset = 0
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset)
    offset = tag.offset
    const number = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (wire === 0) {
      const value = readVarint(buffer, offset)
      offset = value.offset
      result.push({ number, wire, varint: value.value })
    } else if (wire === 1) {
      const fixed64 = buffer.slice(offset, offset + 8)
      offset += 8
      result.push({ number, wire, fixed64 })
    } else if (wire === 2) {
      const length = readVarint(buffer, offset)
      offset = length.offset
      const end = offset + Number(length.value)
      result.push({ number, wire, bytes: buffer.slice(offset, end) })
      offset = end
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`)
    }
  }
  return result
}

function decodeValue(buffer: Uint8Array): string | number | boolean {
  const valueFields = fields(buffer)
  const stringValue = valueFields.find((field) => field.number === 1)?.bytes
  if (stringValue) return text(stringValue)
  const doubleValue = valueFields.find((field) => field.number === 3)?.fixed64
  if (doubleValue) {
    return Buffer.from(doubleValue).readDoubleLE()
  }
  return fieldVarints(valueFields, 7)[0] === 1n
}

function fieldBytes(all: readonly Field[], number: number): Uint8Array[] {
  return all.flatMap((field) => (field.number === number && field.bytes ? [field.bytes] : []))
}

function fieldVarints(all: readonly Field[], number: number): bigint[] {
  return all.flatMap((field) =>
    field.number === number && field.varint !== undefined ? [field.varint] : []
  )
}

function packedVarints(buffer: Uint8Array): bigint[] {
  const result: bigint[] = []
  let offset = 0
  while (offset < buffer.length) {
    const decoded = readVarint(buffer, offset)
    result.push(decoded.value)
    offset = decoded.offset
  }
  return result
}

function readVarint(buffer: Uint8Array, initialOffset: number): { value: bigint; offset: number } {
  let value = 0n
  let shift = 0n
  let offset = initialOffset
  while (offset < buffer.length) {
    const byte = BigInt(buffer[offset] ?? 0)
    offset += 1
    value |= (byte & 0x7fn) << shift
    if ((byte & 0x80n) === 0n) return { value, offset }
    shift += 7n
  }
  throw new Error('Truncated protobuf varint')
}

function text(value: Uint8Array | undefined): string {
  return Buffer.from(value ?? []).toString('utf8')
}
