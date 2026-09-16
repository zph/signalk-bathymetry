import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  csbCsvUrl,
  fetchCsbCsv,
  discoverFiles,
  NoaaCsbStore,
  parseCsbCsv,
  type CsbFileMetadata
} from '../src/noaa-csb'
import { buildTrackLines, NoaaCsbTileRenderer } from '../src/noaa-csb-tiles'
import { encodeSoundingPointTile } from '../src/vector-tiles'
import { tileMercatorBounds } from '../src/geo'

test('labels select shallowest neighbors and reveal more observations as zoom increases', () => {
  const points = Array.from({length:12},(_,i) => ({uniqueId:String(i),fileUuid:'f',
    longitude:.001+i*.00001,latitude:.001,depthM:i===0?3.25:20,observedAtMs:i,
    platform:i===0?'SHALLOW':'DEEP',provider:'test',instrument:''}))
  const renderer = new NoaaCsbTileRenderer({} as NoaaCsbStore)
  const lowTile=tileForPosition(.001,.001,14)
  const highTile=tileForPosition(.001,.001,18)
  const low=renderer.render(14,lowTile.x,lowTile.y,points)
  const high=renderer.render(18,highTile.x,highTile.y,points)
  assert.equal(low.pointCount,1)
  assert.ok(high.pointCount>low.pointCount)
  assert.ok(low.tile.includes(Buffer.from('SHALLOW')))
  assert.ok(!low.tile.includes(Buffer.from('DEEP')))
  assert.ok(!low.tile.includes(Buffer.from('TRACKPOINT')))
  assert.equal(low.soundingCount,points.length)
})

test('detailed tiles include screen-simplified journey lines', () => {
  const points = Array.from({ length: 5000 }, (_, index) => ({
    uniqueId: 'vessel',
    fileUuid: 'journey',
    longitude: -122.45 + index * 0.000001,
    latitude: 37.75 + index * 0.0000005,
    depthM: 12,
    observedAtMs: 1_700_000_000_000 + index * 1000,
    platform: 'test',
    provider: 'test',
    instrument: 'test'
  }))
  const tile = tileForPosition(-122.45, 37.75, 14)
  const rendered = new NoaaCsbTileRenderer({} as NoaaCsbStore).render(
    14,
    tile.x,
    tile.y,
    points
  )
  assert.ok(rendered.tile.includes(Buffer.from('TRACKLINE')))
  const rawPoints = encodeSoundingPointTile(
    points.map((_, index) => ({ point: { x: index % 4096, y: index % 2048 }, properties: {} }))
  )
  assert.ok(rendered.tile.length < rawPoints.length / 2)
})

test('dense journey lines use a bounded, zoom-adaptive vertex budget', () => {
  const tile = tileForPosition(-122.45, 37.75, 14)
  const bounds = tileMercatorBounds(14, tile.x, tile.y)
  const points = Array.from({ length: 40_000 }, (_, index) => ({
    uniqueId: 'vessel',
    fileUuid: 'journey',
    longitude: -122.45 + index * 0.00000005,
    latitude: 37.75 + Math.sin(index / 20) * 0.00001,
    depthM: 12,
    observedAtMs: 1_700_000_000_000 + index * 100,
    platform: 'test',
    provider: 'test',
    instrument: 'test'
  }))
  const midZoom = buildTrackLines(points, bounds, 14)
  const closeZoom = buildTrackLines(points, bounds, 18)
  assert.ok(midZoom.reduce((sum, feature) => sum + feature.line.length, 0) <= 6_000)
  assert.ok(closeZoom.reduce((sum, feature) => sum + feature.line.length, 0) <= 6_000)
  assert.ok(midZoom[0]!.line.length < closeZoom[0]!.line.length)
})

test('track lines never connect anonymous mixed-file aggregates', () => {
  const tile = tileForPosition(-122.45, 37.75, 14)
  const bounds = tileMercatorBounds(14, tile.x, tile.y)
  const aggregate = (index: number) => ({
    uniqueId: 'vessel',
    fileUuid: '',
    longitude: -122.45 + index * 0.0001,
    latitude: 37.75,
    depthM: 12,
    observedAtMs: 1_700_000_000_000 + index * 1000,
    platform: 'test',
    provider: 'test',
    instrument: 'test'
  })
  assert.deepEqual(buildTrackLines([aggregate(0), aggregate(1)], bounds, 14), [])
})

test('dense sounding tiles do not exceed the JavaScript argument stack', () => {
  const tile = encodeSoundingPointTile(
    Array.from({ length: 12000 }, (_, i) => ({
      point: { x: i % 4096, y: Math.floor(i / 4096) },
      properties: { DEPTH: i / 10, PLATFORM: 'test vessel', OBSERVED_AT: 1700000000000 + i }
    }))
  )
  assert.ok(tile.length > 125000)
})

const metadata: CsbFileMetadata = {
  name: '20260719211820949694_45401716-01ab-4c46-ac8e-432c6b1e44ea.tar.gz',
  itemId: 'item-a',
  platform: 'Paikea',
  provider: 'Signal K',
  instrument: 'Airmar DST810'
}

test('falls back to legacy NOAA pointData CSV only on a missing modern key', async () => {
  const urls: string[] = []
  const fetcher: typeof fetch = async (url) => {
    urls.push(String(url))
    return new Response('data', { status: urls.length === 1 ? 404 : 200 })
  }
  const response = await fetchCsbCsv(fetcher, metadata.name, new AbortController().signal)
  assert.equal(response.status, 200)
  assert.equal(urls[1], csbCsvUrl(metadata.name).replace(/\.csv$/, '_pointData.csv'))
})

test('maps NOAA archive names to the public sounding CSV', () => {
  assert.equal(
    csbCsvUrl(metadata.name),
    'https://noaa-dcdb-bathymetry-pds.s3.amazonaws.com/csb/csv/2026/07/19/' +
      '20260719211820949694_45401716-01ab-4c46-ac8e-432c6b1e44ea.csv'
  )
  assert.throws(() => csbCsvUrl('unexpected.zip'), /Unsupported NOAA CSB file name/)
})

test('parses real depths but rejects the NOAA nodata sentinel and out-of-region rows', () => {
  const csv = [
    'UNIQUE_ID,FILE_UUID,LON,LAT,DEPTH,TIME,PLATFORM_NAME,PROVIDER',
    'one,file-a,-178.91,-23.65,15.63,2026-05-25T07:32:45Z,Paikea,Signal K',
    'two,file-a,-178.92,-23.64,-1000000000,2026-05-25T07:32:46Z,Paikea,Signal K',
    'three,file-a,-175,-23.64,9.2,2026-05-25T07:32:47Z,Paikea,Signal K'
  ].join('\n')
  const result = parseCsbCsv(csv, [-179, -23.7, -178.86, -23.58], metadata)
  assert.equal(result.invalid, 1)
  assert.equal(result.soundings.length, 1)
  assert.equal(result.soundings[0]?.depthM, 15.63)
  assert.equal(result.soundings[0]?.instrument, 'Airmar DST810')
})

test('discovers and deduplicates intersecting NOAA files', async () => {
  const requested: URL[] = []
  const fetcher: typeof fetch = async (input) => {
    requested.push(new URL(String(input)))
    return new Response(
      JSON.stringify({
        exceededTransferLimit: false,
        features: [
          {
            attributes: {
              NAME: metadata.name,
              ITEM_ID: metadata.itemId,
              PLATFORM: metadata.platform,
              PROVIDER: metadata.provider,
              INSTRUMENT: metadata.instrument,
              START_DATE: 1,
              END_DATE: 2
            }
          },
          { attributes: { NAME: metadata.name } },
          { attributes: { NAME: 'not-a-csb-file.txt' } }
        ]
      })
    )
  }
  const files = await discoverFiles(fetcher, [-179, -23.7, -178.86, -23.58], 20)
  assert.equal(files.length, 1)
  assert.equal(files[0]?.instrument, metadata.instrument)
  assert.equal(requested[0]?.searchParams.get('geometry'), '-179,-23.7,-178.86,-23.58')
})

test('stores cached observations separately and renders sounding-only vector tiles', (t) => {
  const directory = mkdtempSync(join(process.cwd(), '.signalk-csb-test-'))
  const store = new NoaaCsbStore(join(directory, 'csb.sqlite'))
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const csv = [
    'UNIQUE_ID,FILE_UUID,LON,LAT,DEPTH,TIME,PLATFORM_NAME,PROVIDER',
    'one,file-a,-178.91,-23.65,15.63,2026-05-25T07:32:45Z,Paikea,Signal K',
    'two,file-a,-178.91001,-23.65001,16.1,2026-05-25T07:32:46Z,Paikea,Signal K'
  ].join('\n')
  const parsed = parseCsbCsv(csv, [-179, -23.7, -178.86, -23.58], metadata)
  assert.deepEqual(store.ingestFile(metadata, parsed.soundings, parsed.invalid), {
    inserted: 2,
    duplicate: 0
  })
  assert.equal(store.stats().soundings, 2)
  assert.equal(store.listSoundings([-179, -23.7, -178.86, -23.58]).length, 2)
  store.ingestFile({ ...metadata, quality: { qualification: 'datum_correctable', score: .5,
    eligibleForDirectFusion: false, depthReference: 'transducer', reasons: [], rawMetadata: {},
    sounderDraftM: .65, draftApplied: false } }, parsed.soundings, parsed.invalid)
  const quality = store.listSoundings([-179, -23.7, -178.86, -23.58])[0]?.quality
  assert.equal(quality?.sounderDraftM, .65)
  assert.equal(quality?.draftApplied, false)
  assert.equal(quality?.depthReference, 'transducer')
  // Identity and cursor lookup preserve every original depth without cross-vessel mixing.
  assert.equal(store.journeys().length, 2)
  const first = store.journeyPoints('one', 'file-a', 0, 1)
  assert.equal(first[0]?.depthM, 15.63)
  assert.equal(store.journeyPoints('two', 'file-a')[0]?.depthM, 16.1)
  assert.deepEqual(store.journeyPoints('one', 'file-a', Number(first[0]?.id)), [])
  assert.deepEqual(store.journeyPoints('missing', 'file-a'), [])

  const z = 14
  const tile = tileForPosition(-178.91, -23.65, z)
  const rendered = new NoaaCsbTileRenderer(store, 0, 24).render(z, tile.x, tile.y)
  assert.equal(rendered.soundingCount, 2)
  assert.ok(rendered.pointCount > 0)
  assert.ok(rendered.tile.length > 20)
})

function tileForPosition(longitude: number, latitude: number, z: number): { x: number; y: number } {
  const count = 2 ** z
  const x = Math.floor(((longitude + 180) / 360) * count)
  const latitudeRadians = (latitude * Math.PI) / 180
  const y = Math.floor(((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * count)
  return { x, y }
}
