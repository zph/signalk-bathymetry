import assert from 'node:assert/strict'
import test from 'node:test'
import { qualifyCsbMetadata, withCsbMetadata } from '../src/noaa-csb-metadata'

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

test('fetches Crowbar metadata by the archive filename and retains its S3 cross-reference', async () => {
  let requested: URL | undefined
  const fetcher: typeof fetch = async (input) => {
    requested = new URL(String(input))
    return Response.json({
      items: [
        {
          traceId: 'trace-1',
          fileName: '202501010000_boat.tar.gz',
          lastUpdated: '2026-09-01T00:00:00Z',
          otherLocations: {
            s3: 's3://noaa-dcdb-bathymetry-pds/csb/csv/2025/01/01/202501010000_boat_pointData.csv'
          },
          metadata: {
            crs: { vertical: 'Transducer' },
            time: { startTime: 1735689600000 },
            platform: {
              sensors: [{ type: 'Sounder', draft: 0.6 }],
              correctors: { draftApplied: false }
            }
          }
        }
      ]
    })
  }
  const result = await withCsbMetadata(fetcher, {
    name: '202501010000_boat.tar.gz',
    itemId: 'item',
    platform: 'Boat',
    provider: 'Provider',
    instrument: 'Sounder'
  })
  assert.equal(requested?.searchParams.get('fileNameEquals'), result.name)
  assert.equal(result.quality?.qualification, 'datum_correctable')
  assert.equal(result.quality?.traceId, 'trace-1')
  assert.match(result.quality?.s3Uri ?? '', /_pointData\.csv$/)
})

test('metadata network failure is represented as low confidence without blocking soundings', async () => {
  const result = await withCsbMetadata(
    async () => new Response('down', { status: 503 }),
    {
      name: '202501010000_boat.tar.gz',
      itemId: 'item',
      platform: 'Boat',
      provider: 'Provider',
      instrument: 'Sounder'
    }
  )
  assert.equal(result.quality?.qualification, 'raw_unknown')
  assert.equal(result.quality?.score, 0.18)
  assert.match(result.quality?.reasons[0] ?? '', /metadata_fetch_failed/)
})
