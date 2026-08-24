import type { PluginRouter } from '@signalk/server-api'
import type { Request, Response } from 'express'
import { encodeRgbaPng } from './png'
import type { BathymetryStore } from './store'
import {
  ProjectionUnavailableError,
  type DepthMode,
  type TileLayer,
  type TileRenderer
} from './tiles'
import type { CaptureEngine } from './capture'
import type { HistoryBackfill } from './history-backfill'
import type { AutoBackfill } from './auto-backfill'
import type { BathymetryConfig, QcState, SurfaceCell } from './types'

const EMPTY_TILE = encodeRgbaPng(256, 256, new Uint8Array(256 * 256 * 4))
const TILE_LAYERS = new Set<TileLayer>(['depth', 'confidence', 'age', 'change'])
const DEPTH_MODES = new Set<DepthMode>(['datum', 'water'])

export interface Runtime {
  config: BathymetryConfig
  store: BathymetryStore
  capture: CaptureEngine
  history: HistoryBackfill
  autoBackfill: AutoBackfill
  renderer: TileRenderer
}

export function registerRoutes(router: PluginRouter, getRuntime: () => Runtime | undefined): void {
  const read = router.access('readonly')

  read.get('/status', (_request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    response.json({
      plugin: 'signalk-bathymetry',
      state: 'running',
      warning: 'Supplemental local estimate only; not for primary navigation.',
      config: publicConfig(runtime.config),
      capture: runtime.capture.status(),
      history: { running: runtime.history.isRunning() },
      autoBackfill: runtime.autoBackfill.status(),
      store: runtime.store.stats()
    })
  })

  read.get('/soundings', (request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const qc = stringQuery(request, 'qc')
      if (qc && !['accepted', 'quarantined', 'rejected'].includes(qc)) {
        throw new HttpError(400, 'qc must be accepted, quarantined, or rejected')
      }
      const options: Parameters<BathymetryStore['listSoundings']>[0] = {
        limit: integerQuery(request, 'limit', 1000, 1, 10_000)
      }
      const bbox = optionalBbox(request)
      const fromMs = optionalTime(request, 'from')
      const toMs = optionalTime(request, 'to')
      if (bbox) options.bbox = bbox
      if (fromMs !== undefined) options.fromMs = fromMs
      if (toMs !== undefined) options.toMs = toMs
      if (qc) options.qcState = qc as QcState
      response.json({ soundings: runtime.store.listSoundings(options) })
    } catch (error) {
      sendError(response, error)
    }
  })

  read.get('/cells', (request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const bbox = requiredBbox(request)
      const cells = runtime.store.listCellsForBbox(bbox, runtime.config.targetDatum)
      response.json({
        datum: runtime.config.targetDatum,
        cellSizeM: runtime.config.baseCellMeters,
        grid: 'hex-pointy',
        cells: cells.map((cell) => cellResponse(runtime.store, cell))
      })
    } catch (error) {
      sendError(response, error)
    }
  })

  read.get('/cells/lookup', (request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const latitude = numberQuery(request, 'latitude', -90, 90)
      const longitude = numberQuery(request, 'longitude', -180, 180)
      const cell = runtime.store.lookupCell(latitude, longitude, runtime.config.targetDatum)
      if (!cell) throw new HttpError(404, 'No bathymetry cell covers this position')
      response.json(cellResponse(runtime.store, cell))
    } catch (error) {
      sendError(response, error)
    }
  })

  read.get('/changes', (request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const sinceMs = optionalTime(request, 'since') ?? Date.now() - 30 * 86_400_000
      const cells = runtime.store.listChanges(
        sinceMs,
        runtime.config.targetDatum,
        integerQuery(request, 'limit', 1000, 1, 10_000)
      )
      response.json({ cells: cells.map((cell) => cellResponse(runtime.store, cell)) })
    } catch (error) {
      sendError(response, error)
    }
  })

  read.get('/projection', (request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const atMs = optionalTime(request, 'at') ?? Date.now()
      const tide = runtime.capture.latestTideProjection(atMs)
      if (!tide || tide.stale) throw new HttpError(409, 'No fresh tide is available for this time')
      response.json({
        mode: 'water',
        datum: runtime.config.targetDatum,
        tide,
        formula: 'projectedDepth = datumDepth + tideHeight',
        conservativeFormula:
          'conservativeProjectedDepth = datumDepth + tideHeight - 1.645 * combinedVerticalSigma',
        underKeelFormula:
          'conservativeUnderKeel = datumDepth + tideHeight - surfaceToKeel - 1.645 * combinedVerticalSigma',
        dangerUnderKeelM: runtime.config.dangerUnderKeelM
      })
    } catch (error) {
      sendError(response, error)
    }
  })

  read.get('/tiles/:z/:x/:y.png', (request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const z = integerParam(request, 'z', 0, 24)
      const maxCoordinate = 2 ** z - 1
      const x = integerParam(request, 'x', 0, maxCoordinate)
      const y = integerParam(request, 'y', 0, maxCoordinate, '.png')
      const layer = (stringQuery(request, 'layer') ?? 'depth') as TileLayer
      const mode = (stringQuery(request, 'mode') ?? 'datum') as DepthMode
      if (!TILE_LAYERS.has(layer)) throw new HttpError(400, 'Unknown tile layer')
      if (!DEPTH_MODES.has(mode)) throw new HttpError(400, 'mode must be datum or water')
      const atMs = optionalTime(request, 'at') ?? Date.now()
      const tideBucket = mode === 'water' ? Math.floor(atMs / 60_000) : 0
      const etag = `W/\"hex3-${runtime.store.revision()}-${z}-${x}-${y}-${layer}-${mode}-${tideBucket}-${Number(runtime.config.showDepthLabels)}-${runtime.config.depthLabelMinZoom}\"`
      if (request.headers['if-none-match'] === etag) {
        response.status(304).end()
        return
      }
      const rendered = runtime.renderer.render({ z, x, y, layer, mode, atMs })
      response.set('Content-Type', 'image/png')
      response.set('Cache-Control', mode === 'water' ? 'private, max-age=30' : 'private, max-age=300')
      response.set('ETag', etag)
      response.set('X-Bathymetry-Cell-Count', String(rendered.cellCount))
      response.set('X-Bathymetry-Label-Count', String(rendered.labelCount))
      if (rendered.projection) {
        response.set('X-Bathymetry-Tide-Meters', String(rendered.projection.heightM))
      }
      response.send(rendered.png)
    } catch (error) {
      if (error instanceof ProjectionUnavailableError) {
        // A transparent response keeps Freeboard usable while making the reason observable.
        response.set('Content-Type', 'image/png')
        response.set('Cache-Control', 'no-store')
        response.set('X-Bathymetry-Projection-Error', error.message)
        response.send(EMPTY_TILE)
        return
      }
      sendError(response, error)
    }
  })

  // Routes registered directly on PluginRouter remain administrator-only.
  router.post('/admin/backfill', async (request: Request, response: Response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const body = objectBody(request)
      const fromMs = bodyTime(body, 'from')
      const toMs = bodyTime(body, 'to')
      const result = await runtime.history.run(fromMs, toMs)
      response.json(result)
    } catch (error) {
      sendError(response, error)
    }
  })

  router.post('/admin/reprocess', (_request: Request, response: Response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      response.json({ cells: runtime.store.reprocessAll() })
    } catch (error) {
      sendError(response, error)
    }
  })
}

export function openApi(): object {
  return {
    openapi: '3.0.3',
    info: { title: 'Signal K Local Bathymetry API', version: '0.2.0' },
    paths: {
      '/status': { get: operation('Plugin, capture, and storage status') },
      '/soundings': { get: operation('Query provenance-rich raw soundings and QC states') },
      '/cells': { get: operation('Query rendered bathymetry cells in a bbox') },
      '/cells/lookup': { get: operation('Look up the bathymetry cell at a position') },
      '/changes': { get: operation('List suspected or confirmed seabed changes') },
      '/projection': { get: operation('Describe the current tide projection') },
      '/tiles/{z}/{x}/{y}.png': { get: operation('Render a translucent PNG tile') },
      '/admin/backfill': { post: operation('Import up to 31 days from Signal K History API') },
      '/admin/reprocess': { post: operation('Rebuild QC classifications and surface cells') }
    }
  }
}

function operation(summary: string): object {
  return { summary, responses: { '200': { description: 'Success' } } }
}

function requireRuntime(
  getRuntime: () => Runtime | undefined,
  response: Response
): Runtime | undefined {
  const runtime = getRuntime()
  if (!runtime) response.status(503).json({ error: 'Bathymetry plugin is not running' })
  return runtime
}

function publicConfig(config: BathymetryConfig): Record<string, unknown> {
  return {
    depthPath: config.depthPath,
    depthSource: config.depthSource ?? 'preferred',
    targetDatum: config.targetDatum,
    tideStationId: config.tideStationId,
    tideStationName: config.tideStationName,
    cellSizeM: config.baseCellMeters,
    dangerUnderKeelM: config.dangerUnderKeelM,
    recencyHalfLifeDays: config.recencyHalfLifeDays,
    overlayOpacity: config.overlayOpacity,
    showDepthLabels: config.showDepthLabels,
    depthLabelMinZoom: config.depthLabelMinZoom,
    autoBackfillWhenEmpty: config.autoBackfillWhenEmpty,
    autoBackfillDays: config.autoBackfillDays
  }
}

function cellResponse(store: BathymetryStore, cell: SurfaceCell): Record<string, unknown> {
  return {
    ...cell,
    bounds: store.cellBounds(cell),
    geometry: {
      type: 'Polygon',
      coordinates: [store.cellPolygon(cell)]
    }
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function sendError(response: Response, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500
  response.status(status).json({ error: error instanceof Error ? error.message : String(error) })
}

function stringQuery(request: Request, key: string): string | undefined {
  const value = request.query[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberQuery(request: Request, key: string, minimum: number, maximum: number): number {
  const value = Number(stringQuery(request, key))
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new HttpError(400, `${key} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function integerQuery(
  request: Request,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = stringQuery(request, key)
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, `${key} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function integerParam(
  request: Request,
  key: string,
  minimum: number,
  maximum: number,
  suffix = ''
): number {
  const parameter = request.params[key]
  let raw = Array.isArray(parameter) ? parameter[0] : parameter
  if (suffix && raw?.endsWith(suffix)) raw = raw.slice(0, -suffix.length)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, `${key} is outside the valid tile range`)
  }
  return value
}

function optionalBbox(request: Request): [number, number, number, number] | undefined {
  const raw = stringQuery(request, 'bbox')
  return raw ? parseBbox(raw) : undefined
}

function requiredBbox(request: Request): [number, number, number, number] {
  const raw = stringQuery(request, 'bbox')
  if (!raw) throw new HttpError(400, 'bbox=west,south,east,north is required')
  return parseBbox(raw)
}

function parseBbox(raw: string): [number, number, number, number] {
  const values = raw.split(',').map(Number)
  if (
    values.length !== 4 ||
    values.some((value) => !Number.isFinite(value)) ||
    values[0]! < -180 ||
    values[2]! > 180 ||
    values[1]! < -90 ||
    values[3]! > 90 ||
    values[0]! >= values[2]! ||
    values[1]! >= values[3]!
  ) {
    throw new HttpError(400, 'bbox must be west,south,east,north in WGS84')
  }
  return values as [number, number, number, number]
}

function optionalTime(request: Request, key: string): number | undefined {
  const raw = stringQuery(request, key)
  if (!raw || raw === 'now') return raw === 'now' ? Date.now() : undefined
  const value = Date.parse(raw)
  if (!Number.isFinite(value)) throw new HttpError(400, `${key} must be an ISO 8601 timestamp`)
  return value
}

function objectBody(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new HttpError(400, 'A JSON object body is required')
  }
  return request.body as Record<string, unknown>
}

function bodyTime(body: Record<string, unknown>, key: string): number {
  const raw = body[key]
  if (typeof raw !== 'string') throw new HttpError(400, `${key} is required as ISO 8601`)
  const value = Date.parse(raw)
  if (!Number.isFinite(value)) throw new HttpError(400, `${key} must be ISO 8601`)
  return value
}
