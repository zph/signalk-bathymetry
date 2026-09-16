import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CsbTides, interpolate } from '../src/csb-tides'
import { normalizeConfig, pluginSchema } from '../src/config'
import { NoaaCsbTileRenderer } from '../src/noaa-csb-tiles'
import type { CsbSounding, NoaaCsbStore } from '../src/noaa-csb'

const time = Date.parse('2024-01-01T00:03:00Z')
const sample: CsbSounding = { uniqueId: 'vessel', fileUuid: 'file', longitude: 0.001, latitude: 0.001,
  depthM: 10, observedAtMs: time, platform: 'test', provider: 'test', instrument: 'sonar',
  quality: { depthReference: 'waterline' } }
const config = normalizeConfig({ csbTidalCorrectionEnabled: true, csbTideStationId: '9414290' })
const response = () => Response.json({ metadata: { id: '9414290', lat: '0.001', lon: '0.001' },
  data: [{ t: '2024-01-01 00:00', v: '1', q: 'v', f: '0,0,0,0' },
    { t: '2024-01-01 00:06', v: '2', q: 'v', f: '0,0,0,0' }] })

test('overlapping callers coalesce station/UTC-day requests and queue drains without another render', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'csb-tides-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const calls = new Map<string, number>()
  let active = 0, maximum = 0
  const tides = new CsbTides(directory, config, async input => {
    const url = new URL(String(input))
    const station = url.searchParams.get('station')!
    const day = url.searchParams.get('begin_date')!
    const key = `${station}/${day}`
    calls.set(key, (calls.get(key) ?? 0) + 1)
    active++; maximum = Math.max(maximum, active)
    await new Promise<void>(resolve => setImmediate(resolve))
    active--
    return Response.json({ metadata: { id: station, lat: '0', lon: '0' },
      data: [{ t: '2024-01-01 00:00', v: '1', q: 'v' }] })
  })
  for (let caller = 0; caller < 100; caller++) {
    for (const station of ['9414290', '9414750']) {
      for (let day = 0; day < 3; day++) tides.prefetch(station, time + day * 86_400_000 + caller * 1000)
    }
  }
  assert.equal(tides.status().activeDownloads, 2)
  assert.equal(tides.status().queuedDownloads, 4)
  await tides.idle()
  assert.equal(maximum, 2)
  assert.equal(calls.size, 6)
  assert.ok([...calls.values()].every(count => count === 1))
  assert.equal(tides.status().pendingDownloads, 0)
  assert.equal(tides.status().cache.coalesced, 594)
  tides.prefetch('9414290', time)
  assert.equal(tides.status().cache.memoryHits, 1)
  assert.equal(tides.status().cache.downloads, 6)
  assert.equal(readdirSync(directory).length, 6)
})

test('shutdown settles queued callers without starting additional network work', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'csb-tides-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let calls = 0
  const tides = new CsbTides(directory, config, async (_input, options) => {
    calls++
    await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    return response()
  })
  for (let day = 0; day < 10; day++) tides.prefetch('9414290', time + day * 86_400_000)
  assert.equal(tides.status().pendingDownloads, 10)
  tides.stop()
  await tides.idle()
  assert.equal(calls, 2)
  assert.equal(tides.status().pendingDownloads, 0)
  assert.equal(readdirSync(directory).length, 0)
})

test('toggle defaults off and invalid station/cache configuration is normalized', () => {
  assert.equal(normalizeConfig({}).csbTidalCorrectionEnabled, false)
  assert.equal(normalizeConfig({ csbTideStationId: 'bad' }).csbTideStationId, '')
  assert.equal(normalizeConfig({ csbTideCacheMiB: NaN }).csbTideCacheMiB, 128)
  assert.equal(normalizeConfig({ csbTideCacheMiB: 0 }).csbTideCacheMiB, 1)
  const schema = pluginSchema() as { properties: Record<string, { default?: unknown }> }
  assert.equal(schema.properties.csbTidalCorrectionEnabled?.default, false)
})

test('off means no fetch and no changed values; blank station is explicit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'csb-tides-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return response() }
  const off = new CsbTides(directory, normalizeConfig({}), fetcher)
  assert.deepEqual(off.apply([sample]), [sample])
  assert.equal(calls, 0)
  const missing = new CsbTides(directory, { ...config, csbTideStationId: '' }, fetcher)
  assert.equal(missing.apply([sample])[0]?.tidalCorrection?.status, 'station-required')
  assert.equal(calls, 0)
})

test('background download is coalesced, cached across restart, and sign/offset/provenance are correct', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'csb-tides-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let calls = 0
  const fetcher: typeof fetch = async input => {
    calls++
    const url = new URL(String(input))
    assert.equal(url.searchParams.get('datum'), 'MLLW')
    assert.equal(url.searchParams.get('product'), 'water_level')
    assert.equal(url.searchParams.get('range'), '25')
    return response()
  }
  const tides = new CsbTides(directory, config, fetcher)
  assert.equal(tides.apply([sample, sample])[0]?.tidalCorrection?.status, 'tide-download-pending')
  await tides.idle()
  assert.equal(calls, 1)
  const corrected = tides.apply([sample])[0]!
  assert.equal(corrected.depthM, 8.5)
  assert.equal(corrected.tidalCorrection?.originalDepthM, 10)
  assert.equal(corrected.tidalCorrection?.waterLevelM, 1.5)
  assert.equal(corrected.tidalCorrection?.stationId, '9414290')
  assert.equal(sample.depthM, 10)
  assert.deepEqual(tides.apply([corrected]), [corrected])
  const sensor = { ...sample, quality: { depthReference: 'transducer', sounderDraftM: .7, draftApplied: false } }
  assert.equal(tides.apply([sensor])[0]?.depthM, 9.2)
  assert.equal(tides.apply([{ ...sensor, quality: { ...sensor.quality, draftApplied: true } }])[0]?.depthM, 8.5)
  tides.stop()
  const restarted = new CsbTides(directory, config, fetcher)
  assert.equal(restarted.apply([sample])[0]?.depthM, 8.5)
  assert.equal(calls, 1)
  const tile = new NoaaCsbTileRenderer({} as NoaaCsbStore, 7, 24, restarted).render(14, 8192, 8191, [sample, { ...sample, sampleCount: 3 }])
  assert.equal(tile.pointCount, 2, 'different vertical references never share a bin')
  assert.ok(tile.tile.includes(Buffer.from('MLLW_ESTIMATE')))
  assert.ok(tile.tile.includes(Buffer.from('CSB_ORIGINAL_DEPTH_M')))
})

test('unknown references, mixed samples and already-reduced depths are not corrected', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'csb-tides-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let calls = 0
  const tides = new CsbTides(directory, config, async () => { calls++; return response() })
  for (const [extra, status] of [
    [{ sampleCount: 2 }, 'aggregate-needs-per-observation-correction'],
    [{ quality: { depthReference: 'transducer' } }, 'sensor-reference-unresolved'],
    [{ quality: { qualification: 'datum_corrected' } }, 'already-datum-reduced'],
    [{ observedAtMs: NaN }, 'invalid-time'],
    [{ quality: { erroneous: true } }, 'source-flagged']
  ] as const) {
    const result = tides.apply([{ ...sample, ...extra }])[0]!
    assert.equal(result.depthM, 10)
    assert.equal(result.tidalCorrection?.status, status)
  }
  assert.equal(calls, 0)
  tides.apply([sample]); await tides.idle()
  assert.equal(tides.apply([{ ...sample, latitude: 40 }])[0]?.tidalCorrection?.status, 'outside-station-radius')
  assert.equal(tides.apply([{ ...sample, depthM: 1 }])[0]?.tidalCorrection?.status, 'drying-height-not-renderable')
})

test('preliminary readings and gaps cannot masquerade as verified tides; failures are negatively cached', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'csb-tides-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let calls = 0
  const tides = new CsbTides(directory, config, async () => { calls++; throw new Error('offline') })
  tides.apply([sample]); await tides.idle()
  assert.equal(tides.apply([sample])[0]?.tidalCorrection?.status, 'tide-unavailable')
  assert.equal(calls, 1)
  const other = new CsbTides(join(directory, 'preliminary'), config, async () => Response.json({
    metadata: { id: '9414290', lat: '0', lon: '0' }, data: [{ t: '2024-01-01 00:03', v: '1', q: 'p' }] }))
  other.apply([sample]); await other.idle()
  assert.equal(other.apply([sample])[0]?.tidalCorrection?.status, 'no-verified-water-level')
  assert.equal(interpolate([[0, 0], [720_000, 2]], 360_000), undefined)
  assert.equal(interpolate([[0, 0], [360_000, 2]], -1), undefined)
  assert.equal(interpolate([[0, 0], [360_000, 2]], 360_001), undefined)
  assert.equal(interpolate([[0, 0], [360_000, 2]], 180_000), 1)
})

test('persistent cache enforces byte budget and evicts least recently used blocks', t => {
  const directory = mkdtempSync(join(tmpdir(), 'csb-tides-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const old = join(directory, 'noaa-verified-mllw-v1-old.json')
  const recent = join(directory, 'noaa-verified-mllw-v1-recent.json')
  writeFileSync(old, 'x'.repeat(600_000)); writeFileSync(recent, 'x'.repeat(600_000))
  utimesSync(old, new Date(0), new Date(0))
  new CsbTides(directory, { ...config, csbTideCacheMiB: 1 })
  assert.deepEqual(readdirSync(directory), ['noaa-verified-mllw-v1-recent.json'])
})
