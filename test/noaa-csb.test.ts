import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  csbCsvUrl,
  discoverFiles,
  NoaaCsbStore,
  parseCsbCsv,
  type CsbFileMetadata
} from '../src/noaa-csb'
import { NoaaCsbTileRenderer } from '../src/noaa-csb-tiles'

const metadata: CsbFileMetadata = {
  name: '20260719211820949694_45401716-01ab-4c46-ac8e-432c6b1e44ea.tar.gz',
  itemId: 'item-a',
  platform: 'Paikea',
  provider: 'Signal K',
  instrument: 'Airmar DST810'
}

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
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * count
  )
  return { x, y }
}
