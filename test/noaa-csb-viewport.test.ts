import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { NoaaCsbStore } from '../src/noaa-csb'
import {
  NoaaCsbViewport,
  coverageStrokeWidth,
  coverageUrl
} from '../src/noaa-csb-viewport'

test('viewport demand coalesces, retains full files across areas, and does no work at world zoom', async (t) => {
  const dir = mkdtempSync(join(process.cwd(), '.csb-viewport-'))
  const store = new NoaaCsbStore(join(dir, 'store.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  let indexCalls = 0,
    fileCalls = 0
  const fetcher: typeof fetch = async (input) => {
    if (String(input).includes('/query?')) {
      indexCalls++
      return Response.json({ features: [{ attributes: { NAME: '202609120000_test.tar.gz' } }] })
    }
    fileCalls++
    return new Response(
      'UNIQUE_ID,FILE_UUID,LON,LAT,DEPTH,TIME\nvessel,journey,-178.91,-23.65,12.3,2026-09-12T00:00:00Z\nvessel,journey,-122.4,37.8,8.7,2026-09-12T01:00:00Z'
    )
  }
  const service = new NoaaCsbViewport(store, dir, fetcher)
  await service.ensure(0, 0, 0)
  assert.equal(indexCalls, 0)
  await Promise.all(Array.from({ length: 20 }, () => service.ensure(12, 12, 2324)))
  assert.equal(indexCalls, 1)
  assert.equal(fileCalls, 1)
  assert.equal(store.stats().soundings, 2)
  assert.equal(store.listSoundings([-123, 37, -122, 38])[0]?.depthM, 8.7)
  await service.ensure(12, 13, 2324)
  assert.equal(indexCalls, 2)
  assert.equal(fileCalls, 1)
  await service.ensure(12, 12, 2324)
  assert.equal(indexCalls, 2)
  service.stop()
})

test('coverage export is global, translucent red, and independent of feature query record limits', () => {
  const url = new URL(coverageUrl(0, 0, 0))
  assert.match(url.pathname, /MapServer\/export$/)
  assert.equal(url.searchParams.get('bbox')?.split(',')[0], '-180')
  const style = JSON.parse(url.searchParams.get('dynamicLayers')!)
  assert.deepEqual(style[0].drawingInfo.renderer.symbol.color, [220, 25, 35, 80])
  assert.equal(style[0].drawingInfo.renderer.symbol.width, 4)
  assert.equal(url.searchParams.get('transparent'), 'true')
})

test('coverage survey tracks taper at close zoom without becoming illegible', () => {
  assert.equal(coverageStrokeWidth(8), 4)
  assert.equal(coverageStrokeWidth(9), 1.5)
  assert.ok(Math.abs(coverageStrokeWidth(12) - 1.05) < Number.EPSILON * 10)
  assert.equal(coverageStrokeWidth(15), 0.6)
  assert.equal(coverageStrokeWidth(18), 0.6)

  const url = new URL(coverageUrl(12, 656, 1582))
  const style = JSON.parse(url.searchParams.get('dynamicLayers')!)
  assert.ok(Math.abs(style[0].drawingInfo.renderer.symbol.width - 1.05) < Number.EPSILON * 10)
  assert.deepEqual(style[0].drawingInfo.renderer.symbol.color, [220, 25, 35, 160])
})

test('coverage coalesces concurrent requests and survives restart from disk', async (t) => {
  const dir = mkdtempSync(join(process.cwd(), '.csb-coverage-'))
  const store = new NoaaCsbStore(join(dir, 'store.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  let calls = 0
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const fetcher: typeof fetch = async () => {
    calls++
    return new Response(png)
  }
  const service = new NoaaCsbViewport(store, dir, fetcher)
  const result = await Promise.all(Array.from({ length: 20 }, () => service.coverage(0, 0, 0)))
  assert.equal(calls, 1)
  assert.deepEqual(result[0], png)
  const restarted = new NoaaCsbViewport(store, dir, fetcher)
  await restarted.coverage(0, 0, 0)
  assert.equal(calls, 1)
  service.stop()
  restarted.stop()
})

test('upstream failures stay failures, not cached empty coverage', async (t) => {
  const dir = mkdtempSync(join(process.cwd(), '.csb-failure-'))
  const store = new NoaaCsbStore(join(dir, 'store.sqlite'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return new Response('{}')
  }
  const service = new NoaaCsbViewport(store, dir, fetcher)
  await assert.rejects(service.coverage(0, 0, 0), /PNG/)
  await assert.rejects(service.coverage(0, 0, 0), /PNG/)
  assert.equal(calls, 2)
  service.stop()
})
