import type { PluginRouter } from '@signalk/server-api'
import type { Request, Response } from 'express'
import type { BathymetryStore } from './store'
import {
  ProjectionUnavailableError,
  CELL_SIZE_SCALE_DEFAULT,
  CELL_SIZE_SCALE_MAX,
  CELL_SIZE_SCALE_MIN,
  type DepthMode
} from './tiles'
import type { CaptureEngine } from './capture'
import type { HistoryBackfill } from './history-backfill'
import type { AutoBackfill } from './auto-backfill'
import type { BathymetryConfig, DepthDisplayMode, QcState, SurfaceCell } from './types'
import type { DepthUnitPreferences } from './depth-units'
import { vectorStyle } from './vector-style'
import {
  BATHYMETRY_MVT_REVISION,
  EMPTY_BATHYMETRY_MVT,
  type VectorTileRenderer
} from './vector-tiles'
import type { NoaaCsbImporter, NoaaCsbStore } from './noaa-csb'
import { NOAA_CSB_MVT_REVISION, type NoaaCsbTileRenderer } from './noaa-csb-tiles'
import type { NoaaCsbViewport } from './noaa-csb-viewport'
import type { RawJournal } from './raw-journal'

const DEPTH_MODES = new Set<DepthMode>(['datum', 'water'])
const CURRENT_TILE_CACHE_SECONDS = 600

export interface Runtime {
  journal: RawJournal
  config: BathymetryConfig
  store: BathymetryStore
  capture: CaptureEngine
  history: HistoryBackfill
  autoBackfill: AutoBackfill
  depthUnits: DepthUnitPreferences
  vectorRenderer: VectorTileRenderer
  csbStore: NoaaCsbStore
  csbImporter: NoaaCsbImporter
  csbRenderer: NoaaCsbTileRenderer
  csbViewport: NoaaCsbViewport
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
      depthDisplayUnits: runtime.depthUnits.status(),
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
      response.json({
        cells: cells.map((cell) => cellResponse(runtime.store, cell))
      })
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

  read.get('/vector-style.json', (_request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    response.set('Cache-Control', 'no-cache')
    response.json(vectorStyle(runtime.config))
  })

  read.get('/csb/status', (_request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    response.json({
      warning:
        'Raw crowdsourced observations with unknown vertical datum and vessel offsets; not for navigation.',
      import: runtime.csbImporter.status(),
      viewport: runtime.csbViewport.status(),
      store: runtime.csbStore.stats()
    })
  })

  read.get('/csb/journeys', (_request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    response.json({ journeys: runtime.csbStore.journeys() })
  })

  read.get('/csb/journey', (request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const vessel = stringQuery(request, 'vessel')
      const journey = stringQuery(request, 'journey')
      if (!vessel || !journey) throw new HttpError(400, 'vessel and journey are required')
      const after = integerQuery(request, 'after', 0, 0, Number.MAX_SAFE_INTEGER)
      const points = runtime.csbStore.journeyPoints(vessel, journey, after, 5001)
      const more = points.length > 5000
      if (more) points.pop()
      response.json({ points, next: more ? points.at(-1)?.id : null })
    } catch (error) {
      sendError(response, error)
    }
  })

  read.get('/csb/soundings', (request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const bbox = requiredBbox(request)
      const limit = integerQuery(request, 'limit', 10_000, 1, 100_000)
      response.json({
        datum: 'UNKNOWN',
        warning: 'Raw observed depths; not for navigation.',
        soundings: runtime.csbStore.listSoundings(bbox, limit)
      })
    } catch (error) {
      sendError(response, error)
    }
  })

  read.get('/csb/coverage/:z/:x/:y.png', async (request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const z = integerParam(request, 'z', 0, 24)
      const x = integerParam(request, 'x', 0, 2 ** z - 1)
      const y = integerParam(request, 'y', 0, 2 ** z - 1, '.png')
      const image = await runtime.csbViewport.coverage(z, x, y)
      response.set('Content-Type', 'image/png')
      response.set('Cache-Control', 'private, max-age=86400')
      response.send(image)
    } catch (error) {
      sendError(response, error)
    }
  })

  read.get('/csb/tiles/:z/:x/:y.pbf', async (request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const z = integerParam(request, 'z', 0, 24)
      const maxCoordinate = 2 ** z - 1
      const x = integerParam(request, 'x', 0, maxCoordinate)
      const y = integerParam(request, 'y', 0, maxCoordinate, '.pbf')
      let downloadFailed = false
      try {
        await runtime.csbViewport.ensure(z, x, y)
      } catch {
        // Discovery failures must not hide observations already retained locally.
        // The viewport status retains the upstream error for diagnosis.
        downloadFailed = true
      }
      const etag = `W/"${NOAA_CSB_MVT_REVISION}-${runtime.csbStore.revision()}-${z}-${x}-${y}"`
      if (request.headers['if-none-match'] === etag) {
        response.status(304).end()
        return
      }
      const rendered = runtime.csbRenderer.render(z, x, y)
      if (downloadFailed && rendered.soundingCount === 0) {
        response.status(503).json({ error: 'NOAA discovery unavailable and no cached depths in this tile' })
        return
      }
      response.set('Content-Type', 'application/vnd.mapbox-vector-tile')
      response.set('Cache-Control', downloadFailed ? 'private, max-age=60' : 'private, max-age=86400')
      response.set('X-CSB-Data-Status', downloadFailed ? 'cached-discovery-unavailable' : 'current')
      response.set('ETag', etag)
      response.set('X-CSB-Sounding-Count', String(rendered.soundingCount))
      response.set('X-CSB-Point-Count', String(rendered.pointCount))
      response.set('X-CSB-Cell-Meters', String(rendered.cellMeters))
      response.send(rendered.tile)
    } catch (error) {
      sendError(response, error)
    }
  })

  read.get('/tiles/:z/:x/:y.pbf', (request, response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const z = integerParam(request, 'z', 0, 24)
      const maxCoordinate = 2 ** z - 1
      const x = integerParam(request, 'x', 0, maxCoordinate)
      const y = integerParam(request, 'y', 0, maxCoordinate, '.pbf')
      const mode = (stringQuery(request, 'mode') ?? 'datum') as DepthMode
      if (!DEPTH_MODES.has(mode)) throw new HttpError(400, 'mode must be datum or water')
      const atMs = optionalTime(request, 'at') ?? Date.now()
      const cellSizeScale =
        optionalNumberQuery(request, 'cellScale', CELL_SIZE_SCALE_MIN, CELL_SIZE_SCALE_MAX) ??
        CELL_SIZE_SCALE_DEFAULT
      const tideBucket =
        mode === 'water' ? Math.floor(atMs / (CURRENT_TILE_CACHE_SECONDS * 1000)) : 0
      const unitRevision = runtime.depthUnits.status().revision
      const displayDepth = requestedDisplayDepth(
        stringQuery(request, 'displayDepth'),
        runtime.config.displayDepth
      )
      const etag = `W/\"${BATHYMETRY_MVT_REVISION}-${runtime.store.revision()}-${z}-${x}-${y}-${mode}-${tideBucket}-${cellSizeScale}-${Number(runtime.config.showDepthLabels)}-${runtime.config.depthLabelRelativeSize}-${displayDepth}-${unitRevision}\"`
      if (request.headers['if-none-match'] === etag) {
        response.status(304).end()
        return
      }
      const rendered = runtime.vectorRenderer.render({
        z,
        x,
        y,
        mode,
        atMs,
        cellSizeScale,
        displayDepth
      })
      response.set('Content-Type', 'application/vnd.mapbox-vector-tile')
      response.set(
        'Cache-Control',
        mode === 'water'
          ? `private, max-age=${CURRENT_TILE_CACHE_SECONDS}, must-revalidate`
          : 'private, max-age=300'
      )
      response.set('ETag', etag)
      response.set('X-Bathymetry-Cell-Count', String(rendered.cellCount))
      response.set('X-Bathymetry-Cell-Meters', String(rendered.cellMeters))
      if (rendered.projection) {
        response.set('X-Bathymetry-Tide-Meters', String(rendered.projection.heightM))
      }
      response.send(rendered.tile)
    } catch (error) {
      if (error instanceof ProjectionUnavailableError) {
        response.set('Content-Type', 'application/vnd.mapbox-vector-tile')
        response.set('Cache-Control', 'no-store')
        response.set('X-Bathymetry-Projection-Error', error.message)
        response.send(EMPTY_BATHYMETRY_MVT)
        return
      }
      sendError(response, error)
    }
  })

  // Routes registered directly on PluginRouter remain administrator-only.
  router.post('/admin/recording/status', (_request: Request, response: Response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (runtime) response.json({ ...runtime.journal.status(), capture: runtime.capture.rawStatus() })
  })
  router.post('/admin/recording/read', (request: Request, response: Response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try { response.json(runtime.journal.read(request.body?.afterId ?? 0, request.body?.limit ?? 1000)) }
    catch (error) { sendError(response, new HttpError(400, String(error))) }
  })
  router.post('/admin/recording/sample', (request: Request, response: Response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try { response.json(runtime.journal.sample(request.body?.afterId ?? 0, request.body?.limit ?? 1000)) }
    catch (error) { sendError(response, new HttpError(400, String(error))) }
  })
  router.post('/admin/recording/consent', (request: Request, response: Response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    if (typeof request.body?.enabled !== 'boolean' || (request.body.enabled && request.body.license !== 'CC0-1.0')) {
      response.status(400).json({ error: 'Provide enabled boolean and license CC0-1.0 to opt in to public track publication' }); return
    }
    runtime.journal.consent(request.body.enabled)
    response.json(runtime.journal.status())
  })
  router.post('/admin/recording/prepare', (request: Request, response: Response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try { response.json(runtime.journal.prepare(request.body?.limit ?? 1000)) }
    catch (error) { sendError(response, new HttpError(400, String(error))) }
  })
  router.post('/admin/recording/acknowledge', (request: Request, response: Response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    if (typeof request.body?.batchId !== 'string' || request.body?.receivedByPartner !== true) {
      response.status(400).json({ error: 'Provide batchId and receivedByPartner: true only after confirmed receipt' }); return
    }
    try { runtime.journal.acknowledge(request.body.batchId); response.json(runtime.journal.status()) }
    catch (error) { sendError(response, new HttpError(400, String(error))) }
  })
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

  router.post('/admin/csb/import', (request: Request, response: Response) => {
    const runtime = requireRuntime(getRuntime, response)
    if (!runtime) return
    try {
      const body = objectBody(request)
      const bbox = bodyBbox(body)
      const maxFiles = bodyInteger(body, 'maxFiles', 2000, 1, 2000)
      response.status(202).json(runtime.csbImporter.start(bbox, maxFiles))
    } catch (error) {
      sendError(response, error)
    }
  })
}

export function openApi(): object {
  return {
    openapi: '3.0.3',
    info: { title: 'Signal K Local Bathymetry API', version: '0.6.0' },
    paths: {
      '/admin/recording/status': { post: operation('Administrator raw journal status and publication state') },
      '/admin/recording/read': { post: operation('Read raw observations and calculate depth from captured tide and offsets') },
      '/admin/recording/sample': { post: operation('Download local review GeoJSON without enabling publication') },
      '/admin/recording/consent': { post: operation('Explicitly enable CC0 publication preparation or revoke permission') },
      '/admin/recording/prepare': { post: operation('Prepare or retry a durable local export batch') },
      '/admin/recording/acknowledge': { post: operation('Record confirmed partner receipt and advance the export cursor') },
      '/status': { get: operation('Plugin, capture, and storage status') },
      '/soundings': {
        get: operation('Query provenance-rich raw soundings and QC states')
      },
      '/cells': { get: operation('Query rendered bathymetry cells in a bbox') },
      '/cells/lookup': {
        get: operation('Look up the bathymetry cell at a position')
      },
      '/changes': {
        get: operation('List suspected or confirmed seabed changes')
      },
      '/projection': { get: operation('Describe the current tide projection') },
      '/vector-style.json': {
        get: operation('Describe the Freeboard vector portrayal')
      },
      '/tiles/{z}/{x}/{y}.pbf': {
        get: operation('Render interactive S-57-style MVT cells')
      },
      '/csb/status': {
        get: operation('Inspect cached NOAA crowdsourced depth coverage')
      },
      '/csb/coverage/{z}/{x}/{y}.png': {
        get: operation('NOAA global indexed track coverage, not depth')
      },
      '/csb/journeys': {
        get: operation('List vessel and source-file journey segments')
      },
      '/csb/journey': {
        get: operation('Page original measurements by vessel and journey')
      },
      '/csb/soundings': {
        get: operation('Query cached raw NOAA crowdsourced depths')
      },
      '/csb/tiles/{z}/{x}/{y}.pbf': {
        get: operation('Render cached NOAA crowdsourced depth soundings')
      },
      '/admin/backfill': {
        post: operation('Import up to 31 days from Signal K History API')
      },
      '/admin/reprocess': {
        post: operation('Rebuild QC classifications and surface cells')
      },
      '/admin/csb/import': {
        post: operation('Cache NOAA crowdsourced depths for a region')
      }
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
    positionPath: config.positionPath,
    depthPath: config.depthPath,
    positionSigmaM: config.positionSigmaM,
    velocitySigmaMps: config.velocitySigmaMps,
    maxLiveTimeSkewSeconds: config.maxLiveTimeSkewSeconds,
    motionMaxAgeSeconds: config.motionMaxAgeSeconds,
    attitudeCorrection: config.attitudeCorrection,
    attitudeMaxAgeSeconds: config.attitudeMaxAgeSeconds,
    attitudeSigmaDegrees: config.attitudeSigmaDegrees,
    beamWidthDegrees: config.beamWidthDegrees,
    depthSource: config.depthSource ?? 'preferred',
    targetDatum: config.targetDatum,
    tideStationId: config.tideStationId,
    tideStationName: config.tideStationName,
    cellSizeM: config.baseCellMeters,
    surfaceToKeelM: config.surfaceToKeelM,
    surfaceToTransducerM: config.surfaceToTransducerM,
    dangerUnderKeelM: config.dangerUnderKeelM,
    recencyHalfLifeDays: config.recencyHalfLifeDays,
    overlayOpacity: config.overlayOpacity,
    qcBaseChart: config.qcBaseChart,
    showDepthLabels: config.showDepthLabels,
    depthLabelRelativeSize: config.depthLabelRelativeSize,
    displayDepth: config.displayDepth,
    minZoom: config.minZoom,
    maxZoom: config.maxZoom,
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

function optionalNumberQuery(
  request: Request,
  key: string,
  minimum: number,
  maximum: number
): number | undefined {
  const raw = stringQuery(request, key)
  if (!raw) return undefined
  const value = Number(raw)
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

// The tiles endpoint honors a per-request display-depth choice so a chartplotter can flip between
// the conservative bound and the best estimate without changing plugin configuration. Anything
// other than an exact, known value falls back to the configured default, keeping the conservative
// safety bias.
function requestedDisplayDepth(
  raw: string | undefined,
  configured: DepthDisplayMode
): DepthDisplayMode {
  return raw === 'conservative' || raw === 'predicted' ? raw : configured
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

function bodyBbox(body: Record<string, unknown>): [number, number, number, number] {
  const value = body.bbox
  if (!Array.isArray(value)) throw new HttpError(400, 'bbox is required as [west,south,east,north]')
  return parseBbox(value.join(','))
}

function bodyInteger(
  body: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (body[key] === undefined) return fallback
  const value = Number(body[key])
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, `${key} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}
