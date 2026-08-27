import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../src/config'
import { BathymetryStore } from '../src/store'
import {
  BATHYMETRY_MVT_LAYER,
  BATHYMETRY_MVT_SOUNDINGS_LAYER,
  VectorTileRenderer
} from '../src/vector-tiles'
import { sounding } from './helpers'

test('vector renderer emits queryable S-57 DEPARE cells with quality metadata', (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-bathymetry-mvt-test-'))
  const config = normalizeConfig({ baseCellMeters: 10, minZoom: 0, maxZoom: 24 })
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
  const config = normalizeConfig({ baseCellMeters: 10, minZoom: 0, maxZoom: 24 })
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

test('vector renderer applies the requested zoom-relative cell-size scale', (t) => {
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
    renderer.render({ z: 19, ...tile, mode: 'datum', atMs: input.observedAtMs, cellSizeScale: 2 })
      .cellMeters,
    40
  )
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
