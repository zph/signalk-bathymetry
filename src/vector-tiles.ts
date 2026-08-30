import {
  bboxToCellRange,
  hexCellCenter,
  hexCellVertices,
  tileMercatorBounds
} from './geo'
import type { BathymetryStore } from './store'
import { METRIC_DEPTH_UNITS, type DepthDisplayUnits } from './depth-units'
import {
  aggregateOverviewCells,
  overviewCellMeters,
  ProjectionUnavailableError,
  type DepthMode
} from './tiles'
import type { BathymetryConfig, DepthDisplayMode, SurfaceCell, TideProjection } from './types'

const MVT_EXTENT = 4096
export const BATHYMETRY_MVT_LAYER = 'DEPARE'
export const BATHYMETRY_MVT_SOUNDINGS_LAYER = 'SOUNDG'
export const BATHYMETRY_MVT_REVISION = 'mvt2'

export interface RenderedVectorTile {
  tile: Buffer
  cellCount: number
  cellMeters: number
  projection?: TideProjection
}

/**
 * Renders live bathymetry cells as a Mapbox Vector Tile using S-57 DEPARE depth
 * attributes. The additional BATHY_* properties remain queryable by clients.
 */
export class VectorTileRenderer {
  constructor(
    private readonly store: BathymetryStore,
    private readonly config: BathymetryConfig,
    private readonly getTide: (atMs: number) => TideProjection | undefined,
    private readonly getDepthUnits: () => DepthDisplayUnits = () => METRIC_DEPTH_UNITS
  ) {}

  render(options: {
    z: number
    x: number
    y: number
    mode: DepthMode
    atMs: number
    cellSizeScale?: number
    // Per-request override of the configured primary depth estimate. Absent means the
    // configuration decides.
    displayDepth?: DepthDisplayMode
  }): RenderedVectorTile {
    const cellMeters = overviewCellMeters(
      this.config.baseCellMeters,
      options.z,
      options.cellSizeScale
    )
    if (options.z < this.config.minZoom || options.z > this.config.maxZoom) {
      return { tile: encodeVectorTile([]), cellCount: 0, cellMeters }
    }

    const bounds = tileMercatorBounds(options.z, options.x, options.y)
    let projection: TideProjection | undefined
    if (options.mode === 'water') {
      projection = this.getTide(options.atMs)
      if (!projection || projection.stale) {
        throw new ProjectionUnavailableError('No fresh tide is available for the requested time')
      }
      if (projection.datum !== this.config.targetDatum) {
        throw new ProjectionUnavailableError(
          `Tide datum ${projection.datum} does not match surface datum ${this.config.targetDatum}`
        )
      }
    }

    const queryBounds =
      cellMeters === this.config.baseCellMeters
        ? bounds
        : {
            minX: bounds.minX - cellMeters,
            minY: bounds.minY - cellMeters,
            maxX: bounds.maxX + cellMeters,
            maxY: bounds.maxY + cellMeters
          }
    const range = bboxToCellRange(queryBounds, this.config.baseCellMeters)
    const sourceCells = this.store.getCellsInRange(
      range.minCellX,
      range.minCellY,
      range.maxCellX,
      range.maxCellY,
      this.config.targetDatum
    )
    const cells = aggregateOverviewCells(
      sourceCells,
      this.config.baseCellMeters,
      cellMeters,
      options.mode,
      projection
    )
    const displayDepth = options.displayDepth ?? this.config.displayDepth
    const features = cells.map((cell) =>
      cellFeature(
        cell,
        bounds,
        cellMeters,
        options.mode,
        projection,
        this.config,
        this.getDepthUnits(),
        displayDepth
      )
    )
    const result: RenderedVectorTile = {
      tile: encodeVectorTile(features),
      cellCount: cells.length,
      cellMeters
    }
    if (projection) result.projection = projection
    return result
  }
}

interface VectorFeature {
  properties: Record<string, string | number | boolean>
  ring: Array<{ x: number; y: number }>
  point: { x: number; y: number }
}

function cellFeature(
  cell: SurfaceCell,
  bounds: ReturnType<typeof tileMercatorBounds>,
  cellMeters: number,
  mode: DepthMode,
  projection: TideProjection | undefined,
  config: BathymetryConfig,
  units: DepthDisplayUnits,
  displayDepth: DepthDisplayMode
): VectorFeature {
  const combinedSigmaM = projection
    ? Math.sqrt(cell.verticalSigmaM ** 2 + projection.sigmaM ** 2)
    : cell.verticalSigmaM
  // The chart's primary depth follows the effective display estimate (a per-request choice
  // overrides the configured one). The conservative default keeps the shallow-biased 95 percent
  // lower bound; the predicted option shows the best estimate without the safety margin. The
  // conservative and robust depths always travel as their own properties so consumers can still
  // read both.
  const displayPredicted = displayDepth === 'predicted'
  const depthM = projection
    ? cell.renderDepthM +
      projection.heightM -
      (displayPredicted ? 0 : 1.645 * combinedSigmaM)
    : displayPredicted
      ? cell.renderDepthM
      : cell.conservativeDepthM
  const span = bounds.maxX - bounds.minX
  const ring = hexCellVertices(cell.cellX, cell.cellY, cellMeters).map((vertex) => ({
    x: Math.round(((vertex.x - bounds.minX) / span) * MVT_EXTENT),
    y: Math.round(((bounds.maxY - vertex.y) / span) * MVT_EXTENT)
  }))
  const center = hexCellCenter(cell.cellX, cell.cellY, cellMeters)
  const properties: Record<string, string | number | boolean> = {
    // Meter-native S-57 depth-area attributes drive Binnacle's normal ENC portrayal.
    DRVAL1: depthM,
    DRVAL2: depthM,
    DEPTH: depthM,
    BATHYMETRY_PROVIDER: 'signalk-bathymetry',
    BATHY_MODE: mode,
    BATHY_DATUM: cell.datum,
    BATHY_CELL_X: cell.cellX,
    BATHY_CELL_Y: cell.cellY,
    BATHY_CELL_METERS: cellMeters,
    BATHY_DEPTH_M: depthM,
    BATHY_ROBUST_DEPTH_M: cell.robustDepthM,
    BATHY_RENDER_DEPTH_M: cell.renderDepthM,
    BATHY_CONSERVATIVE_DEPTH_M: cell.conservativeDepthM,
    BATHY_VERTICAL_SIGMA_M: combinedSigmaM,
    BATHY_CONFIDENCE: cell.confidence,
    BATHY_SOUNDING_COUNT: cell.soundingCount,
    BATHY_OBSERVATION_COUNT: cell.observationCount,
    BATHY_PASS_COUNT: cell.passCount,
    BATHY_SOURCE_COUNT: cell.sourceCount,
    BATHY_OLDEST_AT_MS: cell.oldestAtMs,
    BATHY_NEWEST_AT_MS: cell.newestAtMs,
    BATHY_UPDATED_AT_MS: cell.updatedAtMs,
    BATHY_CHANGE_STATE: cell.changeState,
    BATHY_DISPLAY_KIND: displayPredicted ? 'predicted' : 'conservative',
    BATHY_SHOW_DEPTH_LABELS: config.showDepthLabels,
    BATHY_LABEL_RELATIVE_SIZE: config.depthLabelRelativeSize,
    BATHY_LABEL: depthLabel(depthM, units),
    BATHY_LABEL_UNIT: units.symbol,
    BATHY_SAFETY_THRESHOLD_M: config.surfaceToKeelM + config.dangerUnderKeelM,
  }
  if (cell.confidenceReasons?.length) {
    properties.BATHY_CONFIDENCE_REASONS = cell.confidenceReasons.join('|')
  }
  if (cell.coverage !== undefined) {
    properties.BATHY_COVERAGE = cell.coverage
  }
  if (cell.neighborSupportCount !== undefined) {
    properties.BATHY_NEIGHBOR_SUPPORT_COUNT = cell.neighborSupportCount
  }
  if (cell.neighborDepthDeltaM !== undefined) {
    properties.BATHY_NEIGHBOR_DEPTH_DELTA_M = cell.neighborDepthDeltaM
  }
  if (projection) {
    properties.BATHY_TIDE_HEIGHT_M = projection.heightM
    properties.BATHY_TIDE_SIGMA_M = projection.sigmaM
    properties.BATHY_TIDE_STATION = projection.stationName
    properties.BATHY_TIDE_AT_MS = projection.timestampMs
  }
  return {
    properties,
    ring,
    point: {
      x: Math.round(((center.x - bounds.minX) / span) * MVT_EXTENT),
      y: Math.round(((bounds.maxY - center.y) / span) * MVT_EXTENT)
    }
  }
}

function depthLabel(depthM: number, units: DepthDisplayUnits): string {
  const displayed = depthM * units.metersToDisplayFactor
  const decimals = Math.abs(displayed) >= 10 ? 0 : units.decimals
  const factor = 10 ** decimals
  return (Math.floor(displayed * factor) / factor).toFixed(decimals)
}

function encodeVectorTile(features: readonly VectorFeature[]): Buffer {
  const tile = new ProtoWriter()
  tile.bytesField(3, encodeLayer(BATHYMETRY_MVT_LAYER, features, 'polygon'))
  tile.bytesField(3, encodeLayer(BATHYMETRY_MVT_SOUNDINGS_LAYER, features, 'point'))
  return tile.finish()
}

function encodeLayer(
  name: string,
  features: readonly VectorFeature[],
  geometryType: 'polygon' | 'point'
): Buffer {
  const layer = new ProtoWriter()
  layer.uintField(15, 2)
  layer.stringField(1, name)

  const keys: string[] = []
  const keyIndex = new Map<string, number>()
  const values: Array<string | number | boolean> = []
  const valueIndex = new Map<string, number>()
  const encodedFeatures: Buffer[] = []
  for (const feature of features) {
    const tags: number[] = []
    for (const [key, value] of Object.entries(feature.properties)) {
      let keyId = keyIndex.get(key)
      if (keyId === undefined) {
        keyId = keys.length
        keyIndex.set(key, keyId)
        keys.push(key)
      }
      const valueKey = `${typeof value}:${String(value)}`
      let valueId = valueIndex.get(valueKey)
      if (valueId === undefined) {
        valueId = values.length
        valueIndex.set(valueKey, valueId)
        values.push(value)
      }
      tags.push(keyId, valueId)
    }
    encodedFeatures.push(encodeFeature(tags, feature, geometryType))
  }

  for (const feature of encodedFeatures) layer.bytesField(2, feature)
  for (const key of keys) layer.stringField(3, key)
  for (const value of values) layer.bytesField(4, encodeValue(value))
  layer.uintField(5, MVT_EXTENT)

  return layer.finish()
}

function encodeFeature(
  tags: readonly number[],
  vector: VectorFeature,
  geometryType: 'polygon' | 'point'
): Buffer {
  const feature = new ProtoWriter()
  feature.packedUIntField(2, tags)
  feature.uintField(3, geometryType === 'polygon' ? 3 : 1)
  const geometry: number[] = []
  if (geometryType === 'point') {
    geometry.push(command(1, 1), zigZag(vector.point.x), zigZag(vector.point.y))
    feature.packedUIntField(4, geometry)
    return feature.finish()
  }
  const first = vector.ring[0]
  if (!first || vector.ring.length < 3) return feature.finish()
  geometry.push(command(1, 1), zigZag(first.x), zigZag(first.y))
  let previous = first
  geometry.push(command(2, vector.ring.length - 1))
  for (const point of vector.ring.slice(1)) {
    geometry.push(zigZag(point.x - previous.x), zigZag(point.y - previous.y))
    previous = point
  }
  geometry.push(command(7, 1))
  feature.packedUIntField(4, geometry)
  return feature.finish()
}

function encodeValue(value: string | number | boolean): Buffer {
  const writer = new ProtoWriter()
  if (typeof value === 'string') writer.stringField(1, value)
  else if (typeof value === 'boolean') writer.uintField(7, value ? 1 : 0)
  else writer.doubleField(3, value)
  return writer.finish()
}

function command(id: number, count: number): number {
  return (count << 3) | id
}

function zigZag(value: number): number {
  return value < 0 ? -value * 2 - 1 : value * 2
}

class ProtoWriter {
  readonly bytes: number[] = []

  uintField(field: number, value: number): void {
    this.uint((field << 3) | 0)
    this.uint(value)
  }

  stringField(field: number, value: string): void {
    this.bytesField(field, Buffer.from(value, 'utf8'))
  }

  bytesField(field: number, value: Uint8Array): void {
    this.uint((field << 3) | 2)
    this.uint(value.length)
    this.bytes.push(...value)
  }

  packedUIntField(field: number, values: readonly number[]): void {
    const packed = new ProtoWriter()
    for (const value of values) packed.uint(value)
    this.bytesField(field, packed.finish())
  }

  doubleField(field: number, value: number): void {
    this.uint((field << 3) | 1)
    const encoded = Buffer.allocUnsafe(8)
    encoded.writeDoubleLE(value)
    this.bytes.push(...encoded)
  }

  uint(value: number): void {
    let remaining = BigInt(Math.trunc(value))
    while (remaining >= 0x80n) {
      this.bytes.push(Number((remaining & 0x7fn) | 0x80n))
      remaining >>= 7n
    }
    this.bytes.push(Number(remaining))
  }

  finish(): Buffer {
    return Buffer.from(this.bytes)
  }
}

export const EMPTY_BATHYMETRY_MVT = encodeVectorTile([])
