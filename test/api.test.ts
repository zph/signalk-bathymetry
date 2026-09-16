import assert from 'node:assert/strict'
import test from 'node:test'
import type { Request, Response } from 'express'
import type { PluginRouter } from '@signalk/server-api'
import { normalizeConfig } from '../src/config'
import type { Runtime } from '../src/api'
import { EMPTY_BATHYMETRY_MVT } from '../src/vector-tiles'
import { registerRoutes } from '../src/api'

type Handler = (request: Request, response: Response) => unknown

test('cached NOAA depths remain available during discovery outages', async () => {
  for (const count of [0, 12]) {
    const runtime = {
      config: normalizeConfig({}),
      csbViewport: { ensure: async () => { throw new Error('NOAA unavailable') } },
      csbStore: { revision: () => 1 },
      csbRenderer: { render: () => ({ tile: EMPTY_BATHYMETRY_MVT, soundingCount: count, pointCount: count, cellMeters: 5 }) }
    } as unknown as Runtime
    const result = fakeResponse()
    await tileHandler(runtime, '/csb/tiles/:z/:x/:y.pbf')(fakeRequest({}), result.response)
    assert.equal(result.status(), count ? 200 : 503)
    if (count) {
      assert.equal(result.headers.get('X-CSB-Data-Status'), 'cached-discovery-unavailable')
      assert.equal(result.headers.get('Cache-Control'), 'private, max-age=60')
      assert.ok(result.body())
    }
  }
})

test('native NOAA vector zooms are served independently and reject out-of-range zooms', async () => {
  const calls: number[] = []
  const tile = Buffer.from('vector tile')
  const runtime = {
    csbViewport: { nauticalLaneVectors: async (z: number) => { calls.push(z); return tile } }
  } as unknown as Runtime
  for (const z of [9, 10, 11, 12, 13, 14]) {
    const result = fakeResponse()
    await tileHandler(runtime, '/csb/nautical-lanes-vector/:z/:x/:y.pbf')(
      fakeRequest({}, { z: String(z), x: '327', y: '791' }), result.response)
    assert.equal(result.status(), z >= 10 && z <= 13 ? 200 : 400)
    if (result.status() === 200) {
      assert.equal(result.headers.get('Content-Type'), 'application/vnd.mapbox-vector-tile')
      assert.equal(result.headers.get('Cache-Control'), 'private, max-age=86400, immutable')
      assert.deepEqual(result.body(), tile)
    }
  }
  assert.deepEqual(calls, [10, 11, 12, 13])
})

test('tidal tiles bypass conditional caching while background water levels change', async () => {
  const runtime = {
    config: normalizeConfig({ csbTidalCorrectionEnabled: true, csbTideStationId: '9414290' }),
    csbViewport: { ensure: async () => {} },
    csbStore: { revision: () => 1 },
    csbRenderer: { render: () => ({ tile: EMPTY_BATHYMETRY_MVT, soundingCount: 1, pointCount: 1, cellMeters: 5 }) }
  } as unknown as Runtime
  const result = fakeResponse()
  await tileHandler(runtime, '/csb/tiles/:z/:x/:y.pbf')(fakeRequest({}, { z: '6', x: '0', y: '0' }), result.response)
  assert.equal(result.status(), 200)
  assert.equal(result.headers.get('Cache-Control'), 'no-store')
  assert.equal(result.headers.has('ETag'), false)
})

function tileHandler(runtime: Runtime, route = '/tiles/:z/:x/:y.pbf'): Handler {
  const routes = new Map<string, Handler>()
  const accessRouter = {
    get: (path: string, handler: Handler) => {
      routes.set(path, handler)
      return accessRouter
    },
    post: () => accessRouter,
    put: () => accessRouter,
    patch: () => accessRouter,
    delete: () => accessRouter,
  }
  const adminRouter = {
    access: () => accessRouter,
    // Admin routes are out of scope here; record the path so registration stays observable.
    post: (path: string) => adminRoutes.add(path),
  }
  const adminRoutes = new Set<string>()
  registerRoutes(adminRouter as unknown as PluginRouter, () => runtime)
  const handler = routes.get(route)
  assert.ok(handler)
  return handler
}

function fakeRequest(
  query: Record<string, string>,
  params: Record<string, string> = { z: '16', x: '0', y: '0' }
): Request {
  return {
    query,
    params,
    headers: {},
  } as unknown as Request
}

function fakeResponse() {
  const headers = new Map<string, string>()
  let statusCode = 200
  let body: Buffer | undefined
  const response = {
    set(name: string, value: string) {
      headers.set(name, value)
      return response
    },
    status(code: number) {
      statusCode = code
      return response
    },
    send(payload: Buffer) {
      body = payload
      return response
    },
    end() {
      return response
    },
    json() {
      return response
    },
  }
  return { response: response as unknown as Response, headers, status: () => statusCode, body: () => body }
}

function fakeRuntime(displayDepth: 'conservative' | 'predicted'): Runtime {
  const renderCalls: Array<{ displayDepth?: string; mode?: string; cellSizeScale?: number }> = []
  return {
    config: normalizeConfig({ displayDepth }),
    store: { revision: () => 7 } as unknown as Runtime['store'],
    capture: {} as Runtime['capture'],
    history: {} as Runtime['history'],
    autoBackfill: {} as Runtime['autoBackfill'],
    depthUnits: {
      status: () => ({ revision: 3 }),
    } as unknown as Runtime['depthUnits'],
    vectorRenderer: {
      render(options: { displayDepth?: string; mode?: string; cellSizeScale?: number }) {
        renderCalls.push(options)
        return {
          tile: EMPTY_BATHYMETRY_MVT,
          cellCount: 0,
          cellMeters: 10,
        }
      },
    } as unknown as Runtime['vectorRenderer'],
    // expose the render calls for assertions
    ...({ renderCalls } as object),
  } as Runtime
}

test('tiles without a displayDepth parameter render the configured estimate and etag', () => {
  const runtime = fakeRuntime('predicted')
  const handler = tileHandler(runtime)
  const { response, headers } = fakeResponse()

  handler(fakeRequest({}), response)

  const calls = (runtime as unknown as { renderCalls: Array<{ displayDepth?: string }> })
    .renderCalls
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.displayDepth, 'predicted')
  assert.match(headers.get('ETag') ?? '', /predicted/)
})

test('a displayDepth query parameter overrides the configured estimate', () => {
  const runtime = fakeRuntime('conservative')
  const handler = tileHandler(runtime)
  const { response, headers } = fakeResponse()

  handler(fakeRequest({ displayDepth: 'predicted' }), response)

  const calls = (runtime as unknown as { renderCalls: Array<{ displayDepth?: string }> })
    .renderCalls
  assert.equal(calls[0]?.displayDepth, 'predicted')
  assert.match(headers.get('ETag') ?? '', /predicted/)
  assert.doesNotMatch(headers.get('ETag') ?? '', /conservative/)
})

test('an unrecognized displayDepth parameter falls back to the configured estimate', () => {
  const runtime = fakeRuntime('predicted')
  const handler = tileHandler(runtime)
  const { response, headers } = fakeResponse()

  handler(fakeRequest({ displayDepth: 'robust' }), response)

  const calls = (runtime as unknown as { renderCalls: Array<{ displayDepth?: string }> })
    .renderCalls
  assert.equal(calls[0]?.displayDepth, 'predicted')
  assert.match(headers.get('ETag') ?? '', /predicted/)
})

test('the per-request choice changes the etag so both portrayals cache separately', () => {
  const runtime = fakeRuntime('conservative')
  const handler = tileHandler(runtime)
  const { response: plain, headers: plainHeaders } = fakeResponse()
  handler(fakeRequest({}), plain)
  const { response: predicted, headers: predictedHeaders } = fakeResponse()
  handler(fakeRequest({ displayDepth: 'predicted' }), predicted)

  assert.notEqual(plainHeaders.get('ETag'), predictedHeaders.get('ETag'))
})
