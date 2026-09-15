import assert from 'node:assert/strict'
import test from 'node:test'
import { qualifyCsbMetadata, withLocalCsbMetadata } from '../src/noaa-csb-metadata'

test('qualifies a documented chart-datum reduction for direct fusion', () => {
  const quality = qualifyCsbMetadata({
    crs: { vertical: 'ChartDatum' },
    platform: {
      sensors: [{ type: 'Sounder', draft: 0.7 }],
      correctors: {
        draftApplied: true,
        soundSpeedDocumented: true,
        positionOffsetsDocumented: true
      }
    },
    processing: [
      { type: 'VerticalReduction', reference: 'ChartDatum', method: 'ModelledWL' }
    ]
  })
  assert.equal(quality.qualification, 'datum_corrected')
  assert.equal(quality.depthReference, 'chart_datum')
  assert.equal(quality.eligibleForDirectFusion, true)
  assert.ok(quality.score >= 0.95)
})

test('fetches metadata only from the local archive by filename', async () => {
  let requested: URL | undefined
  const fetcher: typeof fetch = async (input) => {
    requested = new URL(String(input))
    return Response.json({
      source: 'local-archive',
      fileName: '202501010000_boat.tar.gz',
      quality: {
        qualification: 'datum_correctable',
        score: 0.72,
        eligibleForDirectFusion: false,
        depthReference: 'transducer',
        reasons: ['draft_available_for_application'],
        rawMetadata: {},
        traceId: 'trace-1',
        metadataLastUpdated: '2026-09-01T00:00:00Z',
        s3Uri: 's3://noaa-dcdb-bathymetry-pds/csb/csv/2025/01/01/202501010000_boat_pointData.csv',
        sounderDraftM: 0.6,
        draftApplied: false
      }
    })
  }
  const result = await withLocalCsbMetadata(fetcher, 'http://archive.local:3011', {
    name: '202501010000_boat.tar.gz',
    itemId: 'item',
    platform: 'Boat',
    provider: 'Provider',
    instrument: 'Sounder'
  })
  assert.equal(requested?.hostname, 'archive.local')
  assert.equal(requested?.pathname, '/api/crowbar/metadata')
  assert.equal(requested?.searchParams.get('fileName'), result.file.name)
  assert.equal(result.state, 'found')
  assert.equal(result.file.quality?.qualification, 'datum_correctable')
  assert.equal(result.file.quality?.traceId, 'trace-1')
  assert.match(result.file.quality?.s3Uri ?? '', /_pointData\.csv$/)
})

test('local archive failure is represented as unavailable without blocking soundings', async () => {
  const result = await withLocalCsbMetadata(
    async () => new Response('down', { status: 503 }),
    'http://archive.local:3011',
    {
      name: '202501010000_boat.tar.gz',
      itemId: 'item',
      platform: 'Boat',
      provider: 'Provider',
      instrument: 'Sounder'
    }
  )
  assert.equal(result.state, 'unavailable')
  assert.equal(result.file.quality?.qualification, 'raw_unknown')
  assert.equal(result.file.quality?.score, 0.18)
  assert.match(result.file.quality?.reasons[0] ?? '', /local_archive_metadata_unavailable/)
})
