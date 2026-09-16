import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BathymetryConfig } from './types'
import type { CsbSounding } from './noaa-csb'

const DAY = 86_400_000
const STEP = 360_000
const VERSION = 'noaa-verified-mllw-v1'
const MAX_ACTIVE = 2
const MAX_PENDING = 256
const MAX_MEMORY_BLOCKS = 64
interface Block {
  fetchedAt: number
  sourceUrl: string
  latitude: number
  longitude: number
  points: Array<[number, number]>
  error?: string
}
export interface CsbTideResult {
  status: string
  originalDepthM: number
  waterLevelM?: number
  sensorOffsetM?: number
  stationId?: string
  sourceUrl?: string
  fetchedAtMs?: number
  method?: string
}

/** A bounded, persistent station/day LRU. Render never waits for NOAA network I/O. */
export class CsbTides {
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly queue: Array<() => void> = []
  private readonly memory = new Map<string, Block>()
  private readonly diskTouchedAt = new Map<string, number>()
  private active = 0
  private readonly counts = { memoryHits: 0, diskHits: 0, coalesced: 0, downloads: 0, deferred: 0 }
  private stopped = false
  private readonly abort = new AbortController()
  private lastError: string | undefined
  constructor(private readonly directory: string, private readonly config: BathymetryConfig,
    private readonly fetcher: typeof fetch = fetch) {
    mkdirSync(directory, { recursive: true })
    this.prune()
  }

  status() {
    return { enabled: this.config.csbTidalCorrectionEnabled, stationId: this.config.csbTideStationId,
      state: !this.config.csbTidalCorrectionEnabled ? 'off' : !this.config.csbTideStationId ? 'station-required' : 'ready',
      pendingDownloads: this.jobs.size, cacheLimitMiB: this.config.csbTideCacheMiB,
      activeDownloads: this.active, queuedDownloads: this.queue.length,
      memoryBlocks: this.memory.size, cache: { ...this.counts },
      lastError: this.lastError, method: VERSION }
  }
  stop() { this.stopped = true; this.abort.abort(); this.pump() }
  async idle() { while (this.jobs.size) await Promise.all(this.jobs.values()) }

  /** Shared by tile requests and future automatic station selection. UTC days, not local days. */
  prefetch(stationId: string, atMs: number): void {
    if (!this.config.csbTidalCorrectionEnabled || this.stopped || !/^\d{7}$/.test(stationId) ||
      !Number.isFinite(atMs) || atMs <= 0 || atMs > Date.now()) return
    const day = Math.floor(atMs / DAY) * DAY
    const key = `${VERSION}-${stationId}-${day}`
    if (!this.read(key)) this.schedule(key, day, stationId)
  }

  apply(soundings: readonly CsbSounding[]): CsbSounding[] {
    if (!this.config.csbTidalCorrectionEnabled) return [...soundings]
    const blocks = new Map<string, Block | undefined>()
    return soundings.map(s => {
      const skip = (status: string): CsbSounding => ({ ...s, tidalCorrection: { status, originalDepthM: s.depthM } })
      if (s.tidalCorrection?.status === 'estimated') return s
      if (!this.config.csbTideStationId) return skip('station-required')
      if (s.quality?.qualification === 'datum_corrected' || s.metadataQualification === 'datum_corrected') return skip('already-datum-reduced')
      if ((s.sampleCount ?? 1) !== 1) return skip('aggregate-needs-per-observation-correction')
      if (!Number.isFinite(s.observedAtMs) || s.observedAtMs <= 0 || s.observedAtMs > Date.now()) return skip('invalid-time')
      if (s.quality?.erroneous) return skip('source-flagged')
      const reference = s.quality?.depthReference ?? s.metadataDepthReference
      let offset: number
      if (reference === 'waterline') offset = 0
      else if (reference === 'transducer' && s.quality?.draftApplied === true) offset = 0
      else if (reference === 'transducer' && s.quality?.draftApplied === false &&
        Number.isFinite(s.quality.sounderDraftM) && s.quality.sounderDraftM! >= 0) offset = s.quality.sounderDraftM!
      else return skip('sensor-reference-unresolved')
      const day = Math.floor(s.observedAtMs / DAY) * DAY
      const key = `${VERSION}-${this.config.csbTideStationId}-${day}`
      if (!blocks.has(key)) blocks.set(key, this.read(key))
      const block = blocks.get(key)
      if (!block) {
        this.schedule(key, day, this.config.csbTideStationId)
        return skip('tide-download-pending')
      }
      if (block.error) return skip('tide-unavailable')
      if (!Number.isFinite(s.latitude) || !Number.isFinite(s.longitude) ||
        distanceKm(s.latitude, s.longitude, block.latitude, block.longitude) > this.config.csbTideMaxDistanceKm) return skip('outside-station-radius')
      const height = interpolate(block.points, s.observedAtMs)
      if (height === undefined) return skip('no-verified-water-level')
      const depthM = s.depthM + offset - height
      // Negative reduced depths are valid drying heights, but this renderer only supports positive depths.
      if (!Number.isFinite(depthM) || depthM <= 0) return skip('drying-height-not-renderable')
      return { ...s, depthM, minDepthM: depthM, maxDepthM: depthM, p10DepthM: depthM, p90DepthM: depthM,
        tidalCorrection: { status: 'estimated', originalDepthM: s.depthM, waterLevelM: height,
          sensorOffsetM: offset, stationId: this.config.csbTideStationId, sourceUrl: block.sourceUrl,
          fetchedAtMs: block.fetchedAt, method: VERSION } }
    })
  }

  private read(key: string): Block | undefined {
    const cached = this.memory.get(key)
    if (cached) {
      this.memory.delete(key)
      if (this.fresh(cached)) {
        this.memory.set(key, cached)
        this.counts.memoryHits++
        // Touch disk LRU at most once per minute, not once per sounding or tile.
        const path = join(this.directory, `${key}.json`)
        try {
          if (Date.now() - (this.diskTouchedAt.get(key) ?? 0) > 60_000) {
            const now = new Date(); utimesSync(path, now, now)
            this.diskTouchedAt.set(key, now.getTime())
          }
        } catch { /* The bounded disk cache may have evicted this memory entry. */ }
        return cached
      }
    }
    if (this.jobs.has(key)) return undefined
    const path = join(this.directory, `${key}.json`)
    try {
      const block = JSON.parse(readFileSync(path, 'utf8')) as Block
      if (!Array.isArray(block.points) || !Number.isFinite(block.fetchedAt) ||
        (!block.error && (!Number.isFinite(block.latitude) || !Number.isFinite(block.longitude))) ||
        !this.fresh(block)) return undefined
      const now = new Date()
      utimesSync(path, now, now)
      this.remember(key, block)
      this.counts.diskHits++
      return block
    } catch { return undefined }
  }

  private fresh(block: Block) {
    return Date.now() - block.fetchedAt < (block.error || !block.points.length ? 3600_000 : 30 * DAY)
  }

  private remember(key: string, block: Block) {
    this.memory.delete(key)
    this.memory.set(key, block)
    this.diskTouchedAt.set(key, Date.now())
    if (this.memory.size > MAX_MEMORY_BLOCKS) {
      const oldest = this.memory.keys().next().value!
      this.memory.delete(oldest)
      this.diskTouchedAt.delete(oldest)
    }
  }

  private schedule(key: string, day: number, stationId: string) {
    if (this.stopped) return
    if (this.jobs.has(key)) { this.counts.coalesced++; return }
    if (this.jobs.size >= MAX_PENDING) { this.counts.deferred++; return }
    let complete!: () => void
    const job = new Promise<void>(resolve => { complete = resolve })
    // Register before starting: overlapping requests share queued AND active work.
    this.jobs.set(key, job)
    this.queue.push(() => {
      if (this.stopped) { this.jobs.delete(key); complete(); return }
      this.active++
      this.counts.downloads++
      void this.download(day, stationId).then(block => {
        if (this.stopped) return
        this.remember(key, block)
        const path = join(this.directory, `${key}.json`)
        writeFileSync(`${path}.tmp`, JSON.stringify(block))
        renameSync(`${path}.tmp`, path)
        this.prune()
      }).catch(error => { this.lastError = String(error) }).finally(() => {
        this.active--
        this.jobs.delete(key)
        complete()
        this.pump()
      })
    })
    this.pump()
  }

  private pump() {
    while (this.queue.length && (this.stopped || this.active < MAX_ACTIVE)) this.queue.shift()!()
  }

  private async download(day: number, stationId: string): Promise<Block> {
    const params = new URLSearchParams({ product: 'water_level', application: 'signalk-bathymetry',
      station: stationId, datum: 'MLLW', units: 'metric', time_zone: 'gmt', format: 'json',
      begin_date: new Date(day).toISOString().slice(0, 10).replace(/-/g, ''), range: '25' })
    const sourceUrl = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${params}`
    try {
      const response = await this.fetcher(sourceUrl, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]) })
      if (!response.ok) throw new Error(`NOAA water levels HTTP ${response.status}`)
      const body = await response.json() as { metadata?: { id?: string; lat?: string; lon?: string }; data?: Array<{ t: string; v: string; q: string; f?: string }> }
      if (body.metadata?.id !== stationId || !Array.isArray(body.data) ||
        !Number.isFinite(Number(body.metadata.lat)) || !Number.isFinite(Number(body.metadata.lon))) throw new Error('NOAA returned no station water levels')
      const points: Array<[number, number]> = body.data.filter(p => p.q === 'v' && p.v.trim() !== '' &&
        (!p.f || p.f.split(',').every(flag => flag.trim() === '0'))).map(p =>
        [Date.parse(p.t.replace(' ', 'T') + 'Z'), Number(p.v)] as [number, number]).filter(p =>
        Number.isFinite(p[0]) && Number.isFinite(p[1])).sort((a,b) => a[0] - b[0])
      this.lastError = undefined
      return { fetchedAt: Date.now(), sourceUrl, latitude: Number(body.metadata.lat), longitude: Number(body.metadata.lon), points }
    } catch (error) {
      this.lastError = String(error)
      return { fetchedAt: Date.now(), sourceUrl, latitude: 0, longitude: 0, points: [], error: String(error) }
    }
  }

  private prune() {
    const files = readdirSync(this.directory).filter(name => name.startsWith(`${VERSION}-`) && name.endsWith('.json'))
      .map(name => { const path = join(this.directory, name); const stat = statSync(path); return { path, size: stat.size, at: stat.mtimeMs } })
      .sort((a,b) => a.at - b.at)
    let size = files.reduce((total, f) => total + f.size, 0)
    for (const file of files) {
      if (size <= this.config.csbTideCacheMiB * 1024 * 1024) break
      unlinkSync(file.path)
      size -= file.size
    }
  }
}

export function interpolate(points: Array<[number, number]>, at: number): number | undefined {
  const i = points.findIndex(p => p[0] >= at)
  if (i < 0) return undefined
  const right = points[i]!
  if (right[0] === at) return right[1]
  const left = points[i - 1]
  if (!left || right[0] - left[0] > STEP || right[0] <= left[0]) return undefined
  return left[1] + (right[1] - left[1]) * (at - left[0]) / (right[0] - left[0])
}

function distanceKm(a: number, b: number, c: number, d: number) {
  const rad = Math.PI / 180
  const h = Math.sin((a-c)*rad/2)**2 + Math.cos(a*rad)*Math.cos(c*rad)*Math.sin((b-d)*rad/2)**2
  return 12_742 * Math.asin(Math.sqrt(Math.min(1, h)))
}
