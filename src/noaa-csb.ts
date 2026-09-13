import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

export type Bbox = [number, number, number, number]

export interface CsbFileMetadata {
  name: string
  itemId: string
  platform: string
  provider: string
  instrument: string
  startAtMs?: number
  endAtMs?: number
}

export interface CsbSounding {
  uniqueId: string
  fileUuid: string
  longitude: number
  latitude: number
  depthM: number
  observedAtMs: number
  platform: string
  provider: string
  instrument: string
}

export interface CsbStoreStats {
  files: number
  soundings: number
  invalidSoundings: number
  latestImportMs?: number
  bounds?: Bbox
}

export interface CsbImportStatus {
  state: 'idle' | 'discovering' | 'downloading' | 'complete' | 'failed'
  bbox?: Bbox
  discoveredFiles: number
  completedFiles: number
  skippedFiles: number
  failedFiles: number
  importedSoundings: number
  invalidSoundings: number
  startedAtMs?: number
  completedAtMs?: number
  lastError?: string
}

const NOAA_INDEX = 'https://gis.ngdc.noaa.gov/arcgis/rest/services/csb/MapServer/1/query'
const NOAA_ARCHIVE = 'https://noaa-dcdb-bathymetry-pds.s3.amazonaws.com'
const PAGE_SIZE = 2000

export class NoaaCsbStore {
  private readonly db: DatabaseSync
  private readonly insertSounding: StatementSync

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath, { timeout: 5000 })
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;')
    this.migrate()
    this.insertSounding = this.db.prepare(`
      INSERT OR IGNORE INTO csb_soundings (
        fingerprint, file_name, unique_id, file_uuid, observed_at_ms,
        lat_e7, lon_e7, depth_mm, platform, provider, instrument
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
  }

  close(): void {
    this.db.close()
  }

  hasFile(name: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM csb_files WHERE name=? AND status='complete'").get(name)
    )
  }

  hasFullFile(name: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM csb_full_files WHERE name=?').get(name))
  }

  markFullFile(name: string): void {
    this.db.prepare('INSERT OR IGNORE INTO csb_full_files(name) VALUES (?)').run(name)
  }

  ingestFile(
    metadata: CsbFileMetadata,
    soundings: readonly CsbSounding[],
    invalidSoundings: number
  ): { inserted: number; duplicate: number } {
    let inserted = 0
    let duplicate = 0
    const importedAtMs = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(`
          INSERT INTO csb_files (name, item_id, platform, provider, instrument, status)
          VALUES (?, ?, ?, ?, ?, 'failed')
          ON CONFLICT(name) DO UPDATE SET
            item_id=excluded.item_id, platform=excluded.platform, provider=excluded.provider,
            instrument=excluded.instrument
        `)
        .run(
          metadata.name,
          metadata.itemId,
          metadata.platform,
          metadata.provider,
          metadata.instrument
        )
      this.db.prepare('DELETE FROM csb_soundings WHERE file_name=?').run(metadata.name)
      this.db.prepare('DELETE FROM csb_full_files WHERE name=?').run(metadata.name)
      for (const sounding of soundings) {
        const fingerprint = createHash('sha256')
          .update(
            [
              metadata.name,
              sounding.observedAtMs,
              sounding.latitude.toFixed(7),
              sounding.longitude.toFixed(7),
              sounding.depthM.toFixed(3)
            ].join('|')
          )
          .digest('hex')
        const result = this.insertSounding.run(
          fingerprint,
          metadata.name,
          sounding.uniqueId,
          sounding.fileUuid,
          sounding.observedAtMs,
          Math.round(sounding.latitude * 1e7),
          Math.round(sounding.longitude * 1e7),
          Math.round(sounding.depthM * 1000),
          sounding.platform || metadata.platform,
          sounding.provider || metadata.provider,
          sounding.instrument || metadata.instrument
        )
        if (Number(result.changes) === 1) inserted += 1
        else duplicate += 1
      }
      this.db
        .prepare(`
          INSERT INTO csb_files (
            name, item_id, platform, provider, instrument, start_at_ms, end_at_ms,
            status, imported_at_ms, sounding_count, invalid_sounding_count, error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?, NULL)
          ON CONFLICT(name) DO UPDATE SET
            item_id=excluded.item_id, platform=excluded.platform, provider=excluded.provider,
            instrument=excluded.instrument, start_at_ms=excluded.start_at_ms,
            end_at_ms=excluded.end_at_ms, status='complete',
            imported_at_ms=excluded.imported_at_ms, sounding_count=excluded.sounding_count,
            invalid_sounding_count=excluded.invalid_sounding_count, error=NULL
        `)
        .run(
          metadata.name,
          metadata.itemId,
          metadata.platform,
          metadata.provider,
          metadata.instrument,
          metadata.startAtMs ?? null,
          metadata.endAtMs ?? null,
          importedAtMs,
          inserted,
          invalidSoundings
        )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { inserted, duplicate }
  }

  markFailed(metadata: CsbFileMetadata, error: string): void {
    this.db
      .prepare(`
        INSERT INTO csb_files (name, item_id, platform, provider, instrument, status, error)
        VALUES (?, ?, ?, ?, ?, 'failed', ?)
        ON CONFLICT(name) DO UPDATE SET status='failed', error=excluded.error
      `)
      .run(
        metadata.name,
        metadata.itemId,
        metadata.platform,
        metadata.provider,
        metadata.instrument,
        error.slice(0, 1000)
      )
  }

  listSoundings(bbox: Bbox, limit = 50_000): CsbSounding[] {
    const rows = this.db
      .prepare(`
        SELECT unique_id, file_uuid, observed_at_ms, lat_e7, lon_e7, depth_mm,
          platform, provider, instrument
        FROM csb_soundings
        WHERE lon_e7 BETWEEN ? AND ? AND lat_e7 BETWEEN ? AND ?
        ORDER BY observed_at_ms DESC
        LIMIT ?
      `)
      .all(
        Math.round(bbox[0] * 1e7),
        Math.round(bbox[2] * 1e7),
        Math.round(bbox[1] * 1e7),
        Math.round(bbox[3] * 1e7),
        limit
      ) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      uniqueId: String(row.unique_id),
      fileUuid: String(row.file_uuid),
      observedAtMs: Number(row.observed_at_ms),
      latitude: Number(row.lat_e7) / 1e7,
      longitude: Number(row.lon_e7) / 1e7,
      depthM: Number(row.depth_mm) / 1000,
      platform: String(row.platform),
      provider: String(row.provider),
      instrument: String(row.instrument)
    }))
  }

  stats(): CsbStoreStats {
    const counts = this.db
      .prepare(`
        SELECT
          (SELECT count(*) FROM csb_files WHERE status='complete') files,
          (SELECT count(*) FROM csb_soundings) soundings,
          (SELECT coalesce(sum(invalid_sounding_count), 0) FROM csb_files WHERE status='complete') invalid,
          (SELECT max(imported_at_ms) FROM csb_files WHERE status='complete') latest
      `)
      .get() as Record<string, unknown>
    const bounds = this.db
      .prepare(`
        SELECT min(lon_e7) west, min(lat_e7) south, max(lon_e7) east, max(lat_e7) north
        FROM csb_soundings
      `)
      .get() as Record<string, unknown>
    const result: CsbStoreStats = {
      files: Number(counts.files),
      soundings: Number(counts.soundings),
      invalidSoundings: Number(counts.invalid)
    }
    if (counts.latest !== null) result.latestImportMs = Number(counts.latest)
    if (bounds.west !== null) {
      result.bounds = [
        Number(bounds.west) / 1e7,
        Number(bounds.south) / 1e7,
        Number(bounds.east) / 1e7,
        Number(bounds.north) / 1e7
      ]
    }
    return result
  }

  revision(): number {
    const row = this.db
      .prepare('SELECT coalesce(max(imported_at_ms),0) revision FROM csb_files')
      .get() as { revision: number }
    return row.revision
  }

  journeys(): Record<string, unknown>[] {
    return this.db
      .prepare(`SELECT unique_id vesselId, file_uuid journeyId,
      max(platform) vessel, max(provider) provider, max(instrument) instrument,
      min(observed_at_ms) startAtMs, max(observed_at_ms) endAtMs,
      count(*) samples, min(depth_mm)/1000.0 minDepthM, max(depth_mm)/1000.0 maxDepthM,
      min(lon_e7)/1e7 west, min(lat_e7)/1e7 south,
      max(lon_e7)/1e7 east, max(lat_e7)/1e7 north
      FROM csb_soundings GROUP BY unique_id, file_uuid ORDER BY startAtMs, vesselId`)
      .all() as Record<string, unknown>[]
  }

  journeyPoints(
    vessel: string,
    journey: string,
    after = 0,
    limit = 5000
  ): Record<string, unknown>[] {
    return this.db
      .prepare(`SELECT id, lon_e7/1e7 longitude, lat_e7/1e7 latitude,
      depth_mm/1000.0 depthM, observed_at_ms observedAtMs, platform vessel,
      provider, instrument FROM csb_soundings
      WHERE unique_id=? AND file_uuid=? AND id>?
      ORDER BY id LIMIT ?`)
      .all(vessel, journey, after, limit) as Record<string, unknown>[]
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS csb_files (
        name TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        provider TEXT NOT NULL,
        instrument TEXT NOT NULL,
        start_at_ms INTEGER,
        end_at_ms INTEGER,
        status TEXT NOT NULL CHECK(status IN ('complete','failed')),
        imported_at_ms INTEGER,
        sounding_count INTEGER NOT NULL DEFAULT 0,
        invalid_sounding_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS csb_soundings (
        id INTEGER PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL REFERENCES csb_files(name) ON DELETE CASCADE,
        unique_id TEXT NOT NULL,
        file_uuid TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        lat_e7 INTEGER NOT NULL,
        lon_e7 INTEGER NOT NULL,
        depth_mm INTEGER NOT NULL,
        platform TEXT NOT NULL,
        provider TEXT NOT NULL,
        instrument TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS csb_position_idx ON csb_soundings(lon_e7, lat_e7);
      CREATE INDEX IF NOT EXISTS csb_time_idx ON csb_soundings(observed_at_ms);
      CREATE INDEX IF NOT EXISTS csb_file_idx ON csb_soundings(file_name);
      CREATE INDEX IF NOT EXISTS csb_journey_idx ON csb_soundings(unique_id, file_uuid, id);
      CREATE TABLE IF NOT EXISTS csb_full_files (name TEXT PRIMARY KEY REFERENCES csb_files(name) ON DELETE CASCADE);
    `)
  }
}

export class NoaaCsbImporter {
  private current: CsbImportStatus = emptyStatus()
  private abortController?: AbortController

  constructor(
    private readonly store: NoaaCsbStore,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  status(): CsbImportStatus {
    const result: CsbImportStatus = { ...this.current }
    if (this.current.bbox) result.bbox = [...this.current.bbox]
    return result
  }

  start(bbox: Bbox, maxFiles = 2000): CsbImportStatus {
    if (this.current.state === 'discovering' || this.current.state === 'downloading') {
      throw new Error('A NOAA CSB import is already running')
    }
    this.abortController = new AbortController()
    this.current = {
      ...emptyStatus(),
      state: 'discovering',
      bbox: [...bbox],
      startedAtMs: Date.now()
    }
    void this.run(bbox, maxFiles, this.abortController.signal)
    return this.status()
  }

  stop(): void {
    this.abortController?.abort()
  }

  private async run(bbox: Bbox, maxFiles: number, signal: AbortSignal): Promise<void> {
    try {
      const files = await discoverFiles(this.fetcher, bbox, maxFiles, signal)
      this.current.discoveredFiles = files.length
      this.current.state = 'downloading'
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (!signal.aborted) {
          const index = cursor
          cursor += 1
          const metadata = files[index]
          if (!metadata) return
          if (this.store.hasFile(metadata.name)) {
            this.current.skippedFiles += 1
            this.current.completedFiles += 1
            continue
          }
          try {
            const response = await this.fetcher(csbCsvUrl(metadata.name), {
              signal
            })
            if (!response.ok) throw new Error(`NOAA archive returned HTTP ${response.status}`)
            const parsed = parseCsbCsv(await response.text(), bbox, metadata)
            const result = this.store.ingestFile(metadata, parsed.soundings, parsed.invalid)
            this.current.importedSoundings += result.inserted
            this.current.invalidSoundings += parsed.invalid
          } catch (error) {
            if (signal.aborted) return
            const message = error instanceof Error ? error.message : String(error)
            this.store.markFailed(metadata, message)
            this.current.failedFiles += 1
            this.current.lastError = `${metadata.name}: ${message}`
          } finally {
            this.current.completedFiles += 1
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker))
      if (signal.aborted) return
      this.current.state = 'complete'
      this.current.completedAtMs = Date.now()
    } catch (error) {
      if (signal.aborted) return
      this.current.state = 'failed'
      this.current.completedAtMs = Date.now()
      this.current.lastError = error instanceof Error ? error.message : String(error)
    }
  }
}

export async function discoverFiles(
  fetcher: typeof fetch,
  bbox: Bbox,
  maxFiles: number,
  signal?: AbortSignal
): Promise<CsbFileMetadata[]> {
  const files = new Map<string, CsbFileMetadata>()
  for (let offset = 0; files.size < maxFiles; offset += PAGE_SIZE) {
    const query = new URLSearchParams({
      where: '1=1',
      geometry: bbox.join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'NAME,ITEM_ID,PLATFORM,PROVIDER,INSTRUMENT,START_DATE,END_DATE',
      returnGeometry: 'false',
      resultOffset: String(offset),
      resultRecordCount: String(Math.min(PAGE_SIZE, maxFiles - files.size)),
      f: 'json'
    })
    const response = await fetcher(`${NOAA_INDEX}?${query}`, signal ? { signal } : undefined)
    if (!response.ok) throw new Error(`NOAA index returned HTTP ${response.status}`)
    const body = (await response.json()) as {
      error?: { message?: string }
      exceededTransferLimit?: boolean
      features?: Array<{ attributes?: Record<string, unknown> }>
    }
    if (body.error) throw new Error(body.error.message || 'NOAA index query failed')
    const features = body.features ?? []
    for (const feature of features) {
      const attributes = feature.attributes ?? {}
      const name = String(attributes.NAME ?? '')
      if (!/^\d{8}.*\.tar\.gz$/i.test(name)) continue
      if (files.has(name)) continue
      const metadata: CsbFileMetadata = {
        name,
        itemId: String(attributes.ITEM_ID ?? ''),
        platform: String(attributes.PLATFORM ?? 'Unknown'),
        provider: String(attributes.PROVIDER ?? 'Unknown'),
        instrument: String(attributes.INSTRUMENT ?? 'Unknown')
      }
      const startAtMs = optionalEpoch(attributes.START_DATE)
      const endAtMs = optionalEpoch(attributes.END_DATE)
      if (startAtMs !== undefined) metadata.startAtMs = startAtMs
      if (endAtMs !== undefined) metadata.endAtMs = endAtMs
      files.set(name, metadata)
      if (files.size >= maxFiles) break
    }
    if (!body.exceededTransferLimit || features.length === 0) break
  }
  return [...files.values()]
}

export function csbCsvUrl(name: string): string {
  const match = /^(\d{4})(\d{2})(\d{2}).*\.tar\.gz$/i.exec(name)
  if (!match) throw new Error(`Unsupported NOAA CSB file name: ${name}`)
  const csv = name.replace(/\.tar\.gz$/i, '.csv')
  return `${NOAA_ARCHIVE}/csb/csv/${match[1]}/${match[2]}/${match[3]}/${csv}`
}

export function parseCsbCsv(
  csv: string,
  bbox: Bbox,
  metadata: CsbFileMetadata
): { soundings: CsbSounding[]; invalid: number } {
  const lines = csv.split(/\r?\n/)
  const header = parseCsvRow(lines.shift() ?? '').map((value) => value.trim().toUpperCase())
  const index = new Map(header.map((name, position) => [name, position]))
  for (const required of ['LON', 'LAT', 'DEPTH', 'TIME']) {
    if (index.get(required) === undefined) throw new Error(`NOAA CSV is missing ${required}`)
  }
  const column = (name: string): number => index.get(name) ?? -1
  const soundings: CsbSounding[] = []
  let invalid = 0
  for (const line of lines) {
    if (!line.trim()) continue
    const values = parseCsvRow(line)
    const longitude = Number(values[column('LON')])
    const latitude = Number(values[column('LAT')])
    const depthM = Number(values[column('DEPTH')])
    const observedAtMs = Date.parse(values[column('TIME')] ?? '')
    const inBounds =
      longitude >= bbox[0] && longitude <= bbox[2] && latitude >= bbox[1] && latitude <= bbox[3]
    if (!inBounds) continue
    if (
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(depthM) ||
      depthM <= 0 ||
      depthM > 12_000 ||
      !Number.isFinite(observedAtMs)
    ) {
      invalid += 1
      continue
    }
    soundings.push({
      uniqueId: values[column('UNIQUE_ID')] ?? '',
      fileUuid: values[column('FILE_UUID')] ?? '',
      longitude,
      latitude,
      depthM,
      observedAtMs,
      platform: values[column('PLATFORM_NAME')] || metadata.platform,
      provider: values[column('PROVIDER')] || metadata.provider,
      instrument: metadata.instrument
    })
  }
  return { soundings, invalid }
}

function parseCsvRow(line: string): string[] {
  const values: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else quoted = !quoted
    } else if (character === ',' && !quoted) {
      values.push(value)
      value = ''
    } else value += character
  }
  values.push(value)
  return values
}

function optionalEpoch(value: unknown): number | undefined {
  const epoch = Number(value)
  return Number.isFinite(epoch) ? epoch : undefined
}

function emptyStatus(): CsbImportStatus {
  return {
    state: 'idle',
    discoveredFiles: 0,
    completedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    importedSoundings: 0,
    invalidSoundings: 0
  }
}
