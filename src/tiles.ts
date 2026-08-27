import { hexCellCenter, hexCellForMercator } from './geo'
import type { SurfaceCell, TideProjection } from './types'

const OVERVIEW_MAX_CELL_METERS = 640
export const CELL_SIZE_SCALE_MIN = 0.5
export const CELL_SIZE_SCALE_MAX = 4
export const CELL_SIZE_SCALE_STEP = 0.25
export const CELL_SIZE_SCALE_DEFAULT = 1

export type DepthMode = 'datum' | 'water'

export class ProjectionUnavailableError extends Error {}

export function overviewCellMeters(
  baseCellMeters: number,
  zoom: number,
  cellSizeScale = CELL_SIZE_SCALE_DEFAULT
): number {
  const boundedScale = Math.max(
    CELL_SIZE_SCALE_MIN,
    Math.min(CELL_SIZE_SCALE_MAX, cellSizeScale)
  )
  const zoomScale = 2 ** Math.max(0, 20 - Math.floor(zoom))
  return Math.max(
    baseCellMeters,
    Math.min(OVERVIEW_MAX_CELL_METERS, baseCellMeters * zoomScale * boundedScale)
  )
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
