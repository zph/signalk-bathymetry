/** Local archive contract: unsimplified water polygons in the requested tile's coordinates.
 * Ring 0 is the exterior; subsequent rings are holes (islands/land). Missing is NOT all-water.
 * Providers must include coastline/island detail at the tile's resolution, not overview masks.
 */
export interface CsbWaterMask {
  version: 1
  z: number
  x: number
  y: number
  extent: 4096
  source: string
  revision: string
  polygons: number[][][][]
}
type Point = readonly number[]
type Ring = readonly Point[]

export class WaterBoundary {
  private constructor(private readonly polygons: CsbWaterMask['polygons']) {}

  static parse(value: unknown, z: number, x: number, y: number): WaterBoundary | undefined {
    if (!value || typeof value !== 'object') return undefined
    const mask = value as CsbWaterMask
    if (mask.version !== 1 || mask.extent !== 4096 || mask.z !== z || mask.x !== x || mask.y !== y ||
      typeof mask.source !== 'string' || !mask.source.trim() || typeof mask.revision !== 'string' ||
      !mask.revision.trim() || !Array.isArray(mask.polygons) || mask.polygons.length > 1024) return undefined
    let vertices = 0
    for (const polygon of mask.polygons) {
      if (!Array.isArray(polygon) || !polygon.length) return undefined
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 4) return undefined
        vertices += ring.length
        if (vertices > 20_000) return undefined
        if (ring.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) return undefined
        if (ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1]) return undefined
        let area = 0
        for (let i = 1; i < ring.length; i++) area += ring[i-1]![0]! * ring[i]![1]! - ring[i]![0]! * ring[i-1]![1]!
        if (!Number.isFinite(area) || Math.abs(area) < 1e-9) return undefined
      }
    }
    return new WaterBoundary(mask.polygons)
  }

  /** Reject an entire interpolation cell if ANY shore or island intersects it.
   * Checking endpoints alone misses peninsulas and islands between endpoints.
   * Conservative cell clipping also avoids rounding a clipped line back onto land.
   */
  containsCell(minX: number, minY: number, maxX: number, maxY: number): boolean {
    const corners = [[minX,minY], [maxX,minY], [maxX,maxY], [minX,maxY]]
    return this.polygons.some(polygon => {
      if (!corners.every(p => inside(p, polygon[0]!))) return false
      if (polygon.slice(1).some(hole => corners.some(p => inside(p, hole)))) return false
      for (const ring of polygon) {
        for (let i = 1; i < ring.length; i++) {
          const a = ring[i-1]!, b = ring[i]!
          // Also detects a tiny island wholly enclosed by the cell.
          if (a[0]! >= minX && a[0]! <= maxX && a[1]! >= minY && a[1]! <= maxY) return false
          for (let side = 0; side < 4; side++) {
            if (intersects(a, b, corners[side]!, corners[(side+1)%4]!)) return false
          }
        }
      }
      return true
    })
  }
}

function inside(p: Point, ring: Ring): boolean {
  let yes = false
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i-1]!, b = ring[i]!
    if ((a[1]! > p[1]!) !== (b[1]! > p[1]!) &&
      p[0]! < (b[0]!-a[0]!) * (p[1]!-a[1]!) / (b[1]!-a[1]!) + a[0]!) yes = !yes
  }
  return yes
}

function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q[0]!-p[0]!) * (r[1]!-p[1]!) - (q[1]!-p[1]!) * (r[0]!-p[0]!)
  if (Math.max(a[0]!,b[0]!) < Math.min(c[0]!,d[0]!) || Math.max(c[0]!,d[0]!) < Math.min(a[0]!,b[0]!) ||
    Math.max(a[1]!,b[1]!) < Math.min(c[1]!,d[1]!) || Math.max(c[1]!,d[1]!) < Math.min(a[1]!,b[1]!)) return false
  return cross(a,b,c) * cross(a,b,d) <= 0 && cross(c,d,a) * cross(c,d,b) <= 0
}
