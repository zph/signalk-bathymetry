import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchCsbCsv, discoverFiles, parseCsbCsv, type Bbox, type NoaaCsbStore } from './noaa-csb'
import { mercatorToLonLat, tileMercatorBounds } from './geo'

const DAY = 86_400_000
const MAX_FILES = 50

export function csbTileBbox(z: number, x: number, y: number): Bbox {
  const b = tileMercatorBounds(z, x, y)
  const sw = mercatorToLonLat(b.minX, b.minY)
  const ne = mercatorToLonLat(b.maxX, b.maxY)
  return [sw.longitude, sw.latitude, ne.longitude, ne.latitude]
}

export function coverageUrl(z: number, x: number, y: number): string {
  // Server-side rendering avoids the feature query's 2,000-record truncation at world zoom.
  const query = new URLSearchParams({
    f: 'image',
    bbox: csbTileBbox(z, x, y).join(','),
    bboxSR: '4326',
    imageSR: '3857',
    size: '256,256',
    format: 'png32',
    transparent: 'true',
    dynamicLayers: JSON.stringify([
      {
        id: 1,
        source: { type: 'mapLayer', mapLayerId: 1 },
        drawingInfo: {
          renderer: {
            type: 'simple',
            symbol: {
              type: 'esriSLS',
              style: 'esriSLSSolid',
              color: [220, 25, 35, z < 9 ? 80 : 160],
              width: z < 9 ? 4 : 1.5
            }
          }
        }
      }
    ])
  })
  return `https://gis.ngdc.noaa.gov/arcgis/rest/services/csb/MapServer/export?${query}`
}

/** Tile demand is the viewport trigger. Bounded, coalesced downloads never scan the world. */
export class NoaaCsbViewport {
  private pending = new Map<string, Promise<void>>()
  private checked = new Map<string, number>()
  private coveragePending = new Map<string, Promise<Buffer>>()
  private tail: Promise<void> = Promise.resolve()
  private abort = new AbortController()
  private lastError: string | undefined

  constructor(
    private readonly store: NoaaCsbStore,
    private readonly cacheDir: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  status() {
    return { pendingAreas: this.pending.size, lastError: this.lastError }
  }
  stop() {
    this.abort.abort()
  }

  async ensure(z: number, x: number, y: number): Promise<void> {
    if (z < 12) return
    const divisor = 2 ** (z - 12)
    x = Math.floor(x / divisor)
    y = Math.floor(y / divisor)
    const key = `12-${x}-${y}`
    if (Date.now() - (this.checked.get(key) ?? 0) < DAY) return
    const existing = this.pending.get(key)
    if (existing) return existing
    if (this.pending.size >= 64)
      throw new Error('NOAA viewport queue is full; retry after downloads finish')
    const bbox = csbTileBbox(12, x, y)
    const task = this.tail
      .then(async () => {
        this.abort.signal.throwIfAborted()
        const files = await discoverFiles(this.fetcher, bbox, MAX_FILES + 1, this.signal())
        for (const file of files.slice(0, MAX_FILES)) {
          if (this.store.hasFullFile(file.name)) continue
          const response = await fetchCsbCsv(this.fetcher, file.name, this.signal())
          if (!response.ok) throw new Error(`NOAA archive returned HTTP ${response.status}`)
          // Keep complete files, not viewport-clipped fragments masquerading as a full cache hit.
          const parsed = parseCsbCsv(await limitedText(response), [-180, -90, 180, 90], file)
          this.abort.signal.throwIfAborted()
          this.store.ingestFile(file, parsed.soundings, parsed.invalid)
          this.store.markFullFile(file.name)
        }
        if (files.length > MAX_FILES) {
          this.lastError = 'Dense NOAA area: first 50 files cached; use the importer for more'
        } else this.lastError = undefined
        this.checked.set(key, Date.now())
        if (this.checked.size > 1024) this.checked.delete(this.checked.keys().next().value!)
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        this.pending.delete(key)
      })
    this.pending.set(key, task)
    this.tail = task.catch(() => {})
    return task
  }

  async coverage(z: number, x: number, y: number): Promise<Buffer> {
    const key = `${z}-${x}-${y}`
    const existing = this.coveragePending.get(key)
    if (existing) return existing
    if (this.coveragePending.size >= 32) throw new Error('NOAA coverage is busy; retry shortly')
    const task = this.loadCoverage(key, z, x, y).finally(() => {
      this.coveragePending.delete(key)
    })
    this.coveragePending.set(key, task)
    return task
  }

  private signal() {
    return AbortSignal.any([this.abort.signal, AbortSignal.timeout(60_000)])
  }

  private async loadCoverage(key: string, z: number, x: number, y: number): Promise<Buffer> {
    const path = join(this.cacheDir, `${key}.json`)
    let cached: { at: number; image: string } | undefined
    try {
      cached = JSON.parse(await readFile(path, 'utf8')) as typeof cached
    } catch {
      /* first request */
    }
    if (cached && Date.now() - cached.at < DAY) return Buffer.from(cached.image, 'base64')
    try {
      const response = await this.fetcher(coverageUrl(z, x, y), { signal: this.signal() })
      if (!response.ok) throw new Error(`NOAA coverage returned HTTP ${response.status}`)
      const image = Buffer.from(await response.arrayBuffer())
      if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error('NOAA coverage did not return a PNG')
      }
      await mkdir(this.cacheDir, { recursive: true })
      await writeFile(path, JSON.stringify({ at: Date.now(), image: image.toString('base64') }))
      return image
    } catch (error) {
      if (cached) return Buffer.from(cached.image, 'base64')
      throw error
    }
  }
}

async function limitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('NOAA archive returned no body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 64 * 1024 * 1024)
        throw new Error('NOAA file exceeds the 64 MB viewport import limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks).toString('utf8')
}
