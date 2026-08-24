import {
  bboxToCellRange,
  hexCellCenter,
  hexCellForMercator,
  hexCellVertices,
  tileMercatorBounds,
  WEB_MERCATOR_LIMIT
} from './geo'
import { encodeRgbaPng } from './png'
import type { DepthDisplayUnits } from './depth-units'
import type { BathymetryStore } from './store'
import type { BathymetryConfig, SurfaceCell, TideProjection } from './types'

const TILE_SIZE = 256
const OVERVIEW_TARGET_PIXELS = 64
const OVERVIEW_MAX_CELL_METERS = 640

export type TileLayer = 'depth' | 'confidence' | 'age' | 'change'
export type DepthMode = 'datum' | 'water'

export class ProjectionUnavailableError extends Error {}

export interface RenderedTile {
  png: Buffer
  cellCount: number
  cellMeters: number
  labelCount: number
  projection?: TideProjection
}

export class TileRenderer {
  constructor(
    private readonly store: BathymetryStore,
    private readonly config: BathymetryConfig,
    private readonly getTide: (atMs: number) => TideProjection | undefined,
    private readonly getDepthUnits: () => DepthDisplayUnits
  ) {}

  render(options: {
    z: number
    x: number
    y: number
    layer: TileLayer
    mode: DepthMode
    atMs: number
  }): RenderedTile {
    const rgba = new Uint8Array(TILE_SIZE * TILE_SIZE * 4)
    const cellMeters = overviewCellMeters(this.config.baseCellMeters, options.z)
    if (options.z < this.config.minZoom || options.z > this.config.maxZoom) {
      return {
        png: encodeRgbaPng(TILE_SIZE, TILE_SIZE, rgba),
        cellCount: 0,
        cellMeters,
        labelCount: 0
      }
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
    // Include enough source-cell context to build the same world-aligned overview
    // cell from either side of an XYZ tile seam.
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
    const changedPolygons: PixelPoint[][] = []
    for (const cell of cells) {
      const polygon = this.paintCell(rgba, cell, bounds, cellMeters, options, projection)
      if (polygon && options.layer === 'depth' && cell.changeState !== 'stable') {
        changedPolygons.push(polygon)
      }
    }
    // All fills are painted before the perimeter. Stroke only exposed geometric
    // edges so adjacent hexes remain one swath and diagonals are anti-aliased.
    paintOuterHexBoundary(rgba, cells, bounds, cellMeters, [25, 35, 45, 190])
    for (const polygon of changedPolygons) paintPolygonBorder(rgba, polygon, [220, 0, 170, 225])

    let labelCount = 0
    if (
      options.layer === 'depth' &&
      this.config.showDepthLabels &&
      options.z >= this.config.depthLabelMinZoom
    ) {
      for (const cell of cells) {
        if (this.paintDepthLabel(rgba, cell, bounds, cellMeters, options, projection)) {
          labelCount += 1
        }
      }
    }
    const result: RenderedTile = {
      png: encodeRgbaPng(TILE_SIZE, TILE_SIZE, rgba),
      cellCount: cells.length,
      cellMeters,
      labelCount
    }
    if (projection) result.projection = projection
    return result
  }

  private paintCell(
    rgba: Uint8Array,
    cell: SurfaceCell,
    bounds: ReturnType<typeof tileMercatorBounds>,
    cellMeters: number,
    options: { layer: TileLayer; mode: DepthMode; atMs: number },
    projection: TideProjection | undefined
  ): PixelPoint[] | undefined {
    const span = bounds.maxX - bounds.minX
    const polygon = hexCellVertices(cell.cellX, cell.cellY, cellMeters).map(
      (vertex) => ({
        x: ((vertex.x - bounds.minX) / span) * TILE_SIZE,
        y: ((bounds.maxY - vertex.y) / span) * TILE_SIZE
      })
    )
    const left = clampPixel(Math.floor(Math.min(...polygon.map((point) => point.x))))
    const right = clampPixel(Math.ceil(Math.max(...polygon.map((point) => point.x))))
    const top = clampPixel(Math.floor(Math.min(...polygon.map((point) => point.y))))
    const bottom = clampPixel(Math.ceil(Math.max(...polygon.map((point) => point.y))))
    if (right <= left || bottom <= top) return undefined

    const color = this.colorForCell(cell, options, projection)
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        if (!pointInPolygon(x + 0.5, y + 0.5, polygon)) continue
        const index = (y * TILE_SIZE + x) * 4
        let pixel = color
        if (options.layer === 'depth' && cell.confidence < 0.55 && (x + y) % 7 < 2) {
          pixel = [70, 70, 75, Math.min(210, color[3] + 40)]
        }
        rgba[index] = pixel[0]
        rgba[index + 1] = pixel[1]
        rgba[index + 2] = pixel[2]
        rgba[index + 3] = pixel[3]
      }
    }
    return polygon
  }

  private paintDepthLabel(
    rgba: Uint8Array,
    cell: SurfaceCell,
    bounds: ReturnType<typeof tileMercatorBounds>,
    cellMeters: number,
    options: { z: number; layer: TileLayer; mode: DepthMode; atMs: number },
    projection: TideProjection | undefined
  ): boolean {
    const center = hexCellCenter(cell.cellX, cell.cellY, cellMeters)
    const span = bounds.maxX - bounds.minX
    const centerX = ((center.x - bounds.minX) / span) * TILE_SIZE
    const centerY = ((bounds.maxY - center.y) / span) * TILE_SIZE

    const combinedSigma = projection
      ? Math.sqrt(cell.verticalSigmaM ** 2 + projection.sigmaM ** 2)
      : cell.verticalSigmaM
    const depthM = projection
      ? cell.renderDepthM + projection.heightM - 1.645 * combinedSigma
      : cell.conservativeDepthM
    const units = this.getDepthUnits()
    const text = formatDepth(depthM * units.metersToDisplayFactor, units.decimals)
    const availableWidth = (cellMeters / span) * TILE_SIZE
    const zoomSteps = Math.max(0, options.z - this.config.depthLabelMinZoom)
    const overviewScale = Math.max(1, Math.round(cellMeters / this.config.baseCellMeters))
    let scale = Math.min(4, 2 ** zoomSteps * overviewScale)
    let padding = scale + 1
    while (scale > 1 && bitmapTextWidth(text, scale) + 2 * padding > availableWidth) {
      scale -= 1
      padding = scale + 1
    }
    const labelWidth = bitmapTextWidth(text, scale)
    const labelHeight = 5 * scale
    if (labelWidth + 2 * padding > availableWidth) return false

    // A label whose center falls just outside this XYZ tile still needs its visible
    // fragment painted here. Rendering the same world-aligned glyph in both tiles
    // prevents digits from being clipped at tile seams.
    const left = Math.round(centerX - labelWidth / 2)
    const top = Math.round(centerY - labelHeight / 2)
    if (
      left >= TILE_SIZE ||
      top >= TILE_SIZE ||
      left + labelWidth <= 0 ||
      top + labelHeight <= 0
    ) {
      return false
    }

    const fill = this.colorForCell(cell, options, projection)
    const labelCenterX = Math.round(centerX)
    const labelCenterY = Math.round(centerY)
    paintLabelPlate(
      rgba,
      labelCenterX,
      labelCenterY,
      labelWidth + 2 * padding,
      labelHeight + 2 * padding,
      Math.max(2, scale),
      [fill[0], fill[1], fill[2], Math.max(225, fill[3])]
    )
    paintBitmapText(rgba, text, labelCenterX, labelCenterY, scale, contrastText(fill))
    return true
  }

  private colorForCell(
    cell: SurfaceCell,
    options: { layer: TileLayer; mode: DepthMode; atMs: number },
    projection: TideProjection | undefined
  ): Rgba {
    const alpha = Math.round(this.config.overlayOpacity * 255)
    if (options.layer === 'confidence') {
      return [...interpolateStops(cell.confidence, CONFIDENCE_STOPS), alpha] as Rgba
    }
    if (options.layer === 'age') {
      const ageDays = Math.max(0, options.atMs - cell.newestAtMs) / 86_400_000
      const freshness = 2 ** (-ageDays / this.config.recencyHalfLifeDays)
      return [...interpolateStops(freshness, AGE_STOPS), alpha] as Rgba
    }
    if (options.layer === 'change') {
      return cell.changeState === 'stable' ? [0, 0, 0, 0] : [220, 0, 170, Math.max(alpha, 180)]
    }

    if (options.mode === 'water' && projection) {
      const combinedSigma = Math.sqrt(cell.verticalSigmaM ** 2 + projection.sigmaM ** 2)
      const underKeelM =
        cell.renderDepthM +
        projection.heightM -
        this.config.surfaceToKeelM -
        1.645 * combinedSigma
      return [...clearanceColor(underKeelM, this.config.dangerUnderKeelM), alpha] as Rgba
    }
    const requiredWaterDepthM = this.config.surfaceToKeelM + this.config.dangerUnderKeelM
    return [...depthColor(cell.conservativeDepthM, requiredWaterDepthM), alpha] as Rgba
  }
}

export function overviewCellMeters(baseCellMeters: number, zoom: number): number {
  if (zoom >= 20) return baseCellMeters
  // At z19, double the native cell without jumping all the way to the far-view
  // target. This makes the 0.01 NM view legible while preserving local detail.
  if (zoom === 19) return Math.min(OVERVIEW_MAX_CELL_METERS, baseCellMeters * 2)
  const metersPerPixel = (2 * WEB_MERCATOR_LIMIT) / (2 ** zoom * TILE_SIZE)
  const requiredMeters = metersPerPixel * OVERVIEW_TARGET_PIXELS
  if (requiredMeters <= baseCellMeters) return baseCellMeters
  const scale = 2 ** Math.ceil(Math.log2(requiredMeters / baseCellMeters))
  return Math.min(OVERVIEW_MAX_CELL_METERS, baseCellMeters * scale)
}

export function aggregateOverviewCells(
  cells: readonly SurfaceCell[],
  baseCellMeters: number,
  displayCellMeters: number,
  mode: DepthMode,
  projection: TideProjection | undefined
): SurfaceCell[] {
  if (displayCellMeters <= baseCellMeters) return [...cells]
  const groups = new Map<string, { cellX: number; cellY: number; members: SurfaceCell[] }>()
  for (const cell of cells) {
    const center = hexCellCenter(cell.cellX, cell.cellY, baseCellMeters)
    const parent = hexCellForMercator(center.x, center.y, displayCellMeters)
    const key = `${parent.x}:${parent.y}`
    let group = groups.get(key)
    if (!group) {
      group = { cellX: parent.x, cellY: parent.y, members: [] }
      groups.set(key, group)
    }
    group.members.push(cell)
  }

  const expectedSourceCells = (displayCellMeters / baseCellMeters) ** 2
  return [...groups.values()].map((group) => {
    const controlling = group.members.reduce((shallowest, candidate) =>
      overviewDepth(candidate, mode, projection) < overviewDepth(shallowest, mode, projection)
        ? candidate
        : shallowest
    )
    const coverageConfidence = Math.sqrt(
      Math.min(1, group.members.length / expectedSourceCells)
    )
    return {
      ...controlling,
      cellX: group.cellX,
      cellY: group.cellY,
      confidence: Math.min(controlling.confidence, coverageConfidence),
      soundingCount: group.members.reduce((total, cell) => total + cell.soundingCount, 0),
      observationCount: group.members.reduce((total, cell) => total + cell.observationCount, 0),
      passCount: Math.max(...group.members.map((cell) => cell.passCount)),
      sourceCount: Math.max(...group.members.map((cell) => cell.sourceCount)),
      oldestAtMs: Math.min(...group.members.map((cell) => cell.oldestAtMs)),
      newestAtMs: controlling.newestAtMs,
      changeState: aggregateChangeState(group.members),
      updatedAtMs: Math.max(...group.members.map((cell) => cell.updatedAtMs))
    }
  })
}

function overviewDepth(
  cell: SurfaceCell,
  mode: DepthMode,
  projection: TideProjection | undefined
): number {
  if (mode !== 'water' || !projection) return cell.conservativeDepthM
  const sigma = Math.sqrt(cell.verticalSigmaM ** 2 + projection.sigmaM ** 2)
  return cell.renderDepthM + projection.heightM - 1.645 * sigma
}

function aggregateChangeState(cells: readonly SurfaceCell[]): SurfaceCell['changeState'] {
  const states = new Set(cells.map((cell) => cell.changeState))
  if (states.has('confirmed')) return 'confirmed'
  if (states.has('suspected_shoaling')) return 'suspected_shoaling'
  if (states.has('candidate_deepening')) return 'candidate_deepening'
  return 'stable'
}

type Rgb = [number, number, number]
type Rgba = [number, number, number, number]
type ColorStop = [number, Rgb]

const CONFIDENCE_STOPS: ColorStop[] = [
  [0, [190, 25, 35]],
  [0.55, [235, 165, 25]],
  [0.8, [80, 180, 80]],
  [1, [20, 120, 70]]
]

const AGE_STOPS: ColorStop[] = [
  [0, [95, 95, 100]],
  [0.5, [190, 135, 65]],
  [1, [45, 175, 120]]
]

function depthColor(depthM: number, requiredWaterDepthM: number): Rgb {
  const safe = Math.max(0.1, requiredWaterDepthM)
  const stops: ColorStop[] = [
    [-1, [135, 45, 35]],
    [0, [210, 45, 35]],
    [safe * 0.5, [245, 120, 35]],
    [safe, [245, 215, 65]],
    [safe * 2, [50, 205, 215]],
    [safe * 4, [35, 120, 205]],
    [Math.max(30, safe * 10), [25, 45, 110]]
  ]
  return interpolateStops(depthM, stops)
}

function clearanceColor(clearanceM: number, dangerM: number): Rgb {
  const threshold = Math.max(0.1, dangerM)
  return interpolateStops(clearanceM, [
    [-threshold, [125, 20, 25]],
    [0, [220, 35, 30]],
    [threshold, [245, 105, 25]],
    [threshold * 2, [245, 215, 65]],
    [Math.max(3, threshold * 4), [45, 195, 205]],
    [Math.max(10, threshold * 10), [30, 85, 175]]
  ])
}

function interpolateStops(value: number, stops: readonly ColorStop[]): Rgb {
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (!first || !last) return [0, 0, 0]
  if (value <= first[0]) return first[1]
  if (value >= last[0]) return last[1]
  for (let index = 1; index < stops.length; index += 1) {
    const upper = stops[index]
    const lower = stops[index - 1]
    if (!upper || !lower || value > upper[0]) continue
    const ratio = (value - lower[0]) / (upper[0] - lower[0])
    return [0, 1, 2].map((channel) =>
      Math.round(lower[1][channel]! + (upper[1][channel]! - lower[1][channel]!) * ratio)
    ) as Rgb
  }
  return last[1]
}

interface PixelPoint {
  x: number
  y: number
}

function pointInPolygon(x: number, y: number, polygon: readonly PixelPoint[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]!
    const b = polygon[previous]!
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

const EDGE_NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
  [1, 0]
]

/** Stroke only the geometric perimeter of the measured swath, never shared edges. */
function paintOuterHexBoundary(
  rgba: Uint8Array,
  cells: readonly SurfaceCell[],
  bounds: ReturnType<typeof tileMercatorBounds>,
  cellMeters: number,
  color: Rgba
): void {
  const occupied = new Set(cells.map((cell) => `${cell.cellX}:${cell.cellY}`))
  const span = bounds.maxX - bounds.minX
  for (const cell of cells) {
    const polygon = hexCellVertices(cell.cellX, cell.cellY, cellMeters).map((vertex) => ({
      x: ((vertex.x - bounds.minX) / span) * TILE_SIZE,
      y: ((bounds.maxY - vertex.y) / span) * TILE_SIZE
    }))
    for (let edge = 0; edge < polygon.length; edge += 1) {
      const neighbor = EDGE_NEIGHBORS[edge]!
      if (occupied.has(`${cell.cellX + neighbor[0]}:${cell.cellY + neighbor[1]}`)) continue
      paintAntialiasedLine(rgba, polygon[edge]!, polygon[(edge + 1) % polygon.length]!, color)
    }
  }
}

function paintPolygonBorder(rgba: Uint8Array, polygon: readonly PixelPoint[], color: Rgba): void {
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index]!
    const end = polygon[(index + 1) % polygon.length]!
    paintAntialiasedLine(rgba, start, end, color)
  }
}

function paintAntialiasedLine(
  rgba: Uint8Array,
  start: PixelPoint,
  end: PixelPoint,
  color: Rgba
): void {
  const minX = Math.floor(Math.min(start.x, end.x) - 1)
  const maxX = Math.ceil(Math.max(start.x, end.x) + 1)
  const minY = Math.floor(Math.min(start.y, end.y) - 1)
  const maxY = Math.ceil(Math.max(start.y, end.y) + 1)
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const lengthSquared = deltaX * deltaX + deltaY * deltaY
  if (lengthSquared === 0) return

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const pixelX = x + 0.5
      const pixelY = y + 0.5
      const projection = Math.max(
        0,
        Math.min(
          1,
          ((pixelX - start.x) * deltaX + (pixelY - start.y) * deltaY) / lengthSquared
        )
      )
      const nearestX = start.x + projection * deltaX
      const nearestY = start.y + projection * deltaY
      const distance = Math.hypot(pixelX - nearestX, pixelY - nearestY)
      const coverage = Math.max(0, Math.min(1, 1 - distance))
      if (coverage > 0) blendPixel(rgba, x, y, color, coverage)
    }
  }
}

function blendPixel(
  rgba: Uint8Array,
  x: number,
  y: number,
  color: Rgba,
  coverage: number
): void {
  if (x < 0 || x >= TILE_SIZE || y < 0 || y >= TILE_SIZE) return
  const index = (y * TILE_SIZE + x) * 4
  const sourceAlpha = (color[3] / 255) * coverage
  const destinationAlpha = rgba[index + 3]! / 255
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha)
  if (outputAlpha <= 0) return
  for (let channel = 0; channel < 3; channel += 1) {
    rgba[index + channel] = Math.round(
      (color[channel]! * sourceAlpha +
        rgba[index + channel]! * destinationAlpha * (1 - sourceAlpha)) /
        outputAlpha
    )
  }
  rgba[index + 3] = Math.round(outputAlpha * 255)
}

const FONT: Readonly<Record<string, readonly string[]>> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '.': ['000', '000', '000', '000', '010'],
  '-': ['000', '000', '111', '000', '000']
}

export function formatDepth(depth: number, decimals: number): string {
  if (Math.abs(depth) >= 10) return String(Math.floor(depth))
  const precision = 10 ** decimals
  return (Math.floor(depth * precision) / precision).toFixed(decimals)
}

function bitmapTextWidth(text: string, scale: number): number {
  return (text.length * 4 - 1) * scale
}

function contrastText(background: Rgba): Rgba {
  const perceivedBrightness =
    (background[0] * 299 + background[1] * 587 + background[2] * 114) / 1000
  return perceivedBrightness >= 125 ? [12, 22, 32, 255] : [255, 255, 255, 255]
}

function paintLabelPlate(
  rgba: Uint8Array,
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  radius: number,
  color: Rgba
): void {
  const left = Math.round(centerX - width / 2)
  const top = Math.round(centerY - height / 2)
  const right = left + width - 1
  const bottom = top + height - 1
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const insetX = Math.min(x - left, right - x)
      const insetY = Math.min(y - top, bottom - y)
      if (insetX < radius && insetY < radius) {
        const deltaX = radius - insetX - 0.5
        const deltaY = radius - insetY - 0.5
        if (Math.hypot(deltaX, deltaY) > radius) continue
      }
      setPixel(rgba, x, y, color)
    }
  }
}

function paintBitmapText(
  rgba: Uint8Array,
  text: string,
  centerX: number,
  centerY: number,
  scale: number,
  color: Rgba
): void {
  const width = bitmapTextWidth(text, scale)
  const height = 5 * scale
  const left = Math.round(centerX - width / 2)
  const top = Math.round(centerY - height / 2)
  for (let characterIndex = 0; characterIndex < text.length; characterIndex += 1) {
    const glyph = FONT[text[characterIndex]!]
    if (!glyph) continue
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (glyph[row]![column] !== '1') continue
        for (let offsetY = 0; offsetY < scale; offsetY += 1) {
          for (let offsetX = 0; offsetX < scale; offsetX += 1) {
            setPixel(
              rgba,
              left + (characterIndex * 4 + column) * scale + offsetX,
              top + row * scale + offsetY,
              color
            )
          }
        }
      }
    }
  }
}

function setPixel(rgba: Uint8Array, x: number, y: number, color: Rgba): void {
  if (x < 0 || x >= TILE_SIZE || y < 0 || y >= TILE_SIZE) return
  const index = (y * TILE_SIZE + x) * 4
  rgba[index] = color[0]
  rgba[index + 1] = color[1]
  rgba[index + 2] = color[2]
  rgba[index + 3] = color[3]
}

function clampPixel(value: number): number {
  return Math.max(0, Math.min(TILE_SIZE, value))
}
