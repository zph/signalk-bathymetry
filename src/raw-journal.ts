import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DepthReference, Position, TideProjection, TimestampedValue } from './types'

export interface RawObservation {
  observedAtMs: number
  receivedAtMs: number
  timestampOrigin: 'instrument' | 'receipt'
  depthM: number
  depthReference: DepthReference
  depthSource: string
  position: TimestampedValue<Position> | null
  tide: TideProjection | null
  surfaceOffsetM: number
  installation: Record<string, unknown>
  quality: string[]
}

/** Independent, forward-only evidence journal. Never stores a corrected depth. */
export class RawJournal {
  private readonly db: DatabaseSync
  constructor(path: string, private readonly loggerVersion = 'unknown') {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { timeout: 5000 })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL UNIQUE,
        observed_at_ms INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS observations_time ON observations(observed_at_ms);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS export_batches (
        id TEXT PRIMARY KEY, after_id INTEGER NOT NULL, through_id INTEGER NOT NULL,
        payload TEXT NOT NULL, acknowledged_at_ms INTEGER);
    `)
    this.db.prepare('INSERT OR IGNORE INTO state VALUES (?, ?)').run('vesselId', randomUUID())
  }

  append(observation: RawObservation): void {
    observation = { ...observation, installation: { ...observation.installation, loggerVersion: this.loggerVersion } }
    const { receivedAtMs: _received, ...evidence } = observation
    const fingerprint = createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
    this.db.prepare('INSERT OR IGNORE INTO observations (fingerprint, observed_at_ms, payload) VALUES (?, ?, ?)')
      .run(fingerprint, observation.observedAtMs, JSON.stringify(observation))
  }

  private get(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM state WHERE key=?').get(key) as { value: string } | undefined)?.value
  }
  private set(key: string, value: string): void {
    this.db.prepare('INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }
  status() {
    const counts = this.db.prepare('SELECT count(*) AS count, min(observed_at_ms) AS firstAtMs, max(observed_at_ms) AS lastAtMs, coalesce(max(id),0) AS lastId FROM observations').get()!
    return { ...counts, vesselId: this.get('vesselId'), publicationEnabled: this.get('consent') === 'CC0-1.0',
      consentAtMs: Number(this.get('consentAtMs')) || null, acknowledgedThroughId: Number(this.get('cursor') ?? 0),
      transport: 'manual-export-only', journalVersion: 1 }
  }

  consent(enabled: boolean): void {
    this.set('consent', enabled ? 'CC0-1.0' : '')
    this.set('consentAtMs', String(Date.now()))
  }

  read(afterId = 0, limit = 1000) {
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid journal cursor or limit')
    const rows = this.db.prepare('SELECT id, payload FROM observations WHERE id>? ORDER BY id LIMIT ?').all(afterId, limit)
    return rows.map(row => {
      const raw = JSON.parse(String(row.payload)) as RawObservation
      // Recalculate from the captured offset and contemporaneous tide, never today's tide.
      const correctedDepthM = raw.tide && !raw.tide.stale && raw.quality.length === 0
        ? raw.depthM + raw.surfaceOffsetM - raw.tide.heightM : null
      return { id: Number(row.id), raw, correctedDepthM, correctedDatum: correctedDepthM === null ? null : raw.tide!.datum,
        offsetsVerified: raw.installation.offsetsVerified === true }
    })
  }

  sample(afterId = 0, limit = 1000) {
    const rows = this.read(afterId, limit)
    const features = rows.filter(row => row.raw.quality.length === 0 && row.raw.position).map(({ id, raw }) => ({
      type: 'Feature', id,
      geometry: { type: 'Point', coordinates: [raw.position!.value.longitude, raw.position!.value.latitude] },
      properties: { time: new Date(raw.observedAtMs).toISOString(), depth: raw.depthM,
        depthReference: raw.depthReference, depthSource: raw.depthSource, positionSource: raw.position!.source,
        positionTime: new Date(raw.position!.timestampMs).toISOString(),
        installation: raw.installation, surfaceOffsetM: raw.surfaceOffsetM }
    }))
    return { type: 'FeatureCollection', properties: {
      purpose: 'Local review sample; receiving Trusted Node must map and validate submission metadata',
      vesselId: this.get('vesselId'), coordinateReferenceSystem: 'EPSG:4326',
      afterId, throughId: rows.at(-1)?.id ?? afterId, scannedCount: rows.length,
      excludedCount: rows.length - features.length, logger: 'signalk-bathymetry', journalVersion: 1
    }, features }
  }

  prepare(limit = 1000) {
    if (this.get('consent') !== 'CC0-1.0') throw new Error('Publication is disabled; explicit CC0 opt-in is required')
    const cursor = Number(this.get('cursor') ?? 0)
    const pending = this.db.prepare('SELECT id, payload FROM export_batches WHERE after_id=? AND acknowledged_at_ms IS NULL ORDER BY rowid LIMIT 1').get(cursor)
    if (pending) return { batchId: String(pending.id), sample: JSON.parse(String(pending.payload)) }
    const sample = this.sample(cursor, limit)
    if (!sample.properties.scannedCount) return { batchId: null, sample }
    const batchId = createHash('sha256').update(JSON.stringify(sample)).digest('hex')
    this.db.prepare('INSERT INTO export_batches (id, after_id, through_id, payload) VALUES (?, ?, ?, ?)')
      .run(batchId, cursor, sample.properties.throughId, JSON.stringify(sample))
    return { batchId, sample }
  }

  acknowledge(batchId: string): void {
    if (this.get('consent') !== 'CC0-1.0') throw new Error('Publication is disabled')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const batch = this.db.prepare('SELECT * FROM export_batches WHERE id=?').get(batchId)
      if (!batch) throw new Error('Unknown export batch')
      if (batch.acknowledged_at_ms === null) {
        if (Number(batch.after_id) !== Number(this.get('cursor') ?? 0)) throw new Error('Export cursor conflict')
        this.set('cursor', String(batch.through_id))
        this.db.prepare('UPDATE export_batches SET acknowledged_at_ms=? WHERE id=?').run(Date.now(), batchId)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close(): void { this.db.close() }
}
