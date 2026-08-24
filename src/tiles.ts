import { bboxToCellRange, tileMercatorBounds } from './geo'
import { encodeRgbaPng } from './png'
import type { BathymetryStore } from './store'
import type { BathymetryConfig, SurfaceCell, TideProjection } from './types'

const TILE_SIZE = 256

export type TileLayer = 'depth' | 'confidence' | 'age' | 'change'
export type DepthMode = 'datum' | 'water'

export class ProjectionUnavailableError extends Error {}

export interface RenderedTile {
  png: Buffer
  cellCount: number
  projection?: TideProjection
}

export class TileRenderer {
  constructor(
    private readonly store: BathymetryStore,
    private readonly config: BathymetryConfig,
    private readonly getTide: (atMs: number) => TideProjection | undefined
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
    if (options.z < this.config.minZoom || options.z > this.config.maxZoom) {
      return { png: encodeRgbaPng(TILE_SIZE, TILE_SIZE, rgba), cellCount: 0 }
    }
    const bounds = tileMercatorBounds(options.z, options.x, options.y)
    const range = bboxToCellRange(bounds, this.config.baseCellMeters)
    const cells = this.store.getCellsInRange(
      range.minCellX,
      range.minCellY,
      range.maxCellX,
      range.maxCellY,
      this.config.targetDatum
    )
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
    for (const cell of cells) this.paintCell(rgba, cell, bounds, options, projection)
    const result: RenderedTile = {
      png: encodeRgbaPng(TILE_SIZE, TILE_SIZE, rgba),
      cellCount: cells.length
    }
    if (projection) result.projection = projection
    return result
  }

  private paintCell(
    rgba: Uint8Array,
    cell: SurfaceCell,
    bounds: ReturnType<typeof tileMercatorBounds>,
    options: { layer: TileLayer; mode: DepthMode; atMs: number },
    projection: TideProjection | undefined
  ): void {
    const span = bounds.maxX - bounds.minX
    const cellMinX = cell.cellX * this.config.baseCellMeters
    const cellMaxX = cellMinX + this.config.baseCellMeters
    const cellMinY = cell.cellY * this.config.baseCellMeters
    const cellMaxY = cellMinY + this.config.baseCellMeters
    const left = clampPixel(Math.floor(((cellMinX - bounds.minX) / span) * TILE_SIZE))
    const right = clampPixel(Math.ceil(((cellMaxX - bounds.minX) / span) * TILE_SIZE))
    const top = clampPixel(Math.floor(((bounds.maxY - cellMaxY) / span) * TILE_SIZE))
    const bottom = clampPixel(Math.ceil(((bounds.maxY - cellMinY) / span) * TILE_SIZE))
    if (right <= left || bottom <= top) return

    const color = this.colorForCell(cell, options, projection)
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
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
    if (cell.changeState !== 'stable' && options.layer === 'depth') {
      paintBorder(rgba, left, top, right, bottom, [220, 0, 170, 225])
    }
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

function paintBorder(
  rgba: Uint8Array,
  left: number,
  top: number,
  right: number,
  bottom: number,
  color: Rgba
): void {
  for (let x = left; x < right; x += 1) {
    setPixel(rgba, x, top, color)
    setPixel(rgba, x, bottom - 1, color)
  }
  for (let y = top; y < bottom; y += 1) {
    setPixel(rgba, left, y, color)
    setPixel(rgba, right - 1, y, color)
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
