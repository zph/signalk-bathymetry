import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  bboxToCellRange,
  cellForPosition,
  hexCellMercatorBounds,
  hexCellVertices,
  lonLatToMercator,
  mercatorToLonLat
} from './geo'
import { median, robustSigma, weightedGeometricMean } from './statistics'
import type {
  BathymetryConfig,
  ChangeState,
  QcState,
  SoundingInput,
  StoreStats,
  SurfaceCell
} from './types'

const MODEL_VERSION = 4
const GRID_VERSION = 'hex-pointy-v1'
const DAY_MS = 86_400_000
const AXIAL_NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1]
] as const

interface RawCellRow {
  id: number
  pass_id: string
  depth_source: string
  datum_depth_mm: number
  vertical_sigma_mm: number
  observed_at_ms: number
  aggregation_kind: 'point' | 'stationary_window'
  sample_count: number
  rejected_sample_count: number
}

interface ExistingCellRow {
  robust_depth_mm: number
  newest_at_ms: number
}

interface PassEstimate {
  passId: string
  depthM: number
  newestAtMs: number
  oldestAtMs: number
  soundingIds: number[]
}

interface DepthCluster {
  passes: PassEstimate[]
  centerM: number
  newestAtMs: number
  oldestAtMs: number
}

export class BathymetryStore {
  private readonly db: DatabaseSync
  private readonly insertRaw: StatementSync
  private readonly insertClassification: StatementSync
  private readonly selectRawCell: StatementSync
  private readonly selectExistingCell: StatementSync
  private readonly upsertCell: StatementSync

  constructor(
    databasePath: string,
    private readonly config: BathymetryConfig
  ) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath, { timeout: 5000 })
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;')
    this.migrate()
    this.insertRaw = this.db.prepare(`
      INSERT OR IGNORE INTO raw_soundings (
        fingerprint, observed_at_ms, ingested_at_ms, origin, context, track_id, pass_id,
        lat_e7, lon_e7, cell_x, cell_y, position_source,
        depth_raw_mm, depth_reference, depth_source,
        surface_to_keel_mm, surface_to_transducer_mm,
        tide_height_mm, tide_datum, tide_station_id, tide_station_name,
        tide_method, tide_source, tide_observed_at_ms,
        datum_depth_mm, vertical_sigma_mm, sog_mmps, cog_true_urad, heave_mm,
        input_time_skew_ms, aggregation_kind, sample_count, rejected_sample_count,
        window_start_ms, window_end_ms
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `)
    this.insertClassification = this.db.prepare(`
      INSERT INTO qc_classifications (sounding_id, model_version, qc_state, reasons_json, classified_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sounding_id, model_version) DO UPDATE SET
        qc_state=excluded.qc_state,
        reasons_json=excluded.reasons_json,
        classified_at_ms=excluded.classified_at_ms
    `)
    this.selectRawCell = this.db.prepare(`
      SELECT id, pass_id, depth_source, datum_depth_mm, vertical_sigma_mm, observed_at_ms,
        aggregation_kind, sample_count, rejected_sample_count
      FROM raw_soundings
      WHERE cell_x=? AND cell_y=? AND tide_datum=?
      ORDER BY observed_at_ms, id
    `)
    this.selectExistingCell = this.db.prepare(`
      SELECT robust_depth_mm, newest_at_ms
      FROM surface_cells
      WHERE cell_x=? AND cell_y=? AND datum=? AND model_version=?
    `)
    this.upsertCell = this.db.prepare(`
      INSERT INTO surface_cells (
        cell_x, cell_y, datum, model_version, robust_depth_mm, render_depth_mm,
        conservative_depth_mm, vertical_sigma_mm, confidence_base,
        sounding_count, observation_count, pass_count, source_count, oldest_at_ms, newest_at_ms,
        change_state, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cell_x, cell_y, datum, model_version) DO UPDATE SET
        robust_depth_mm=excluded.robust_depth_mm,
        render_depth_mm=excluded.render_depth_mm,
        conservative_depth_mm=excluded.conservative_depth_mm,
        vertical_sigma_mm=excluded.vertical_sigma_mm,
        confidence_base=excluded.confidence_base,
        sounding_count=excluded.sounding_count,
        observation_count=excluded.observation_count,
        pass_count=excluded.pass_count,
        source_count=excluded.source_count,
        oldest_at_ms=excluded.oldest_at_ms,
        newest_at_ms=excluded.newest_at_ms,
        change_state=excluded.change_state,
        updated_at_ms=excluded.updated_at_ms
    `)
    const modelCoverage = this.db
      .prepare(`
        SELECT
          (SELECT count(*) FROM raw_soundings) AS raw_count,
          (SELECT count(*) FROM qc_classifications WHERE model_version=?) AS classified_count
      `)
      .get(MODEL_VERSION) as Record<string, unknown>
    if (Number(modelCoverage.classified_count) < Number(modelCoverage.raw_count)) {
      this.reprocessAll()
    }
  }

  close(): void {
    this.db.close()
  }

  ingest(soundings: readonly SoundingInput[]): { inserted: number; duplicate: number } {
    if (soundings.length === 0) return { inserted: 0, duplicate: 0 }
    const affected = new Map<string, { x: number; y: number; datum: string }>()
    let inserted = 0
    let duplicate = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const sounding of soundings) {
        const cell = cellForPosition(
          { latitude: sounding.latitude, longitude: sounding.longitude },
          this.config.baseCellMeters
        )
        const result = this.insertRaw.run(...this.rawParameters(sounding, cell.x, cell.y))
        if (Number(result.changes) === 0) {
          duplicate += 1
          continue
        }
        inserted += 1
        affected.set(`${cell.x}:${cell.y}:${sounding.tideDatum}`, {
          x: cell.x,
          y: cell.y,
          datum: sounding.tideDatum
        })
      }
      for (const cell of affected.values()) this.rebuildCell(cell.x, cell.y, cell.datum)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { inserted, duplicate }
  }

  reprocessAll(): number {
    const rows = this.db
      .prepare('SELECT DISTINCT cell_x, cell_y, tide_datum FROM raw_soundings')
      .all() as unknown as Array<{ cell_x: number; cell_y: number; tide_datum: string }>
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('DELETE FROM qc_classifications WHERE model_version=?')
        .run(MODEL_VERSION)
      this.db.prepare('DELETE FROM surface_cells WHERE model_version=?').run(MODEL_VERSION)
      for (const row of rows) this.rebuildCell(row.cell_x, row.cell_y, row.tide_datum)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return rows.length
  }

  getCellsInRange(
    minCellX: number,
    minCellY: number,
    maxCellX: number,
    maxCellY: number,
    datum: string,
    limit = 100_000
  ): SurfaceCell[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM surface_cells
        WHERE cell_x BETWEEN ? AND ? AND cell_y BETWEEN ? AND ?
          AND datum=? AND model_version=?
        LIMIT ?
      `)
      .all(minCellX, maxCellX, minCellY, maxCellY, datum, MODEL_VERSION, limit) as unknown as Record<
      string,
      unknown
    >[]
    return this.applyNeighborhoodConfidence(rows.map((row) => this.mapCell(row)))
  }

  lookupCell(latitude: number, longitude: number, datum: string): SurfaceCell | undefined {
    const cell = cellForPosition({ latitude, longitude }, this.config.baseCellMeters)
    return this.getCellsInRange(cell.x - 1, cell.y - 1, cell.x + 1, cell.y + 1, datum, 20)
      .find((candidate) => candidate.cellX === cell.x && candidate.cellY === cell.y)
  }

  listCellsForBbox(bbox: [number, number, number, number], datum: string): SurfaceCell[] {
    const southwest = lonLatToMercator({ longitude: bbox[0], latitude: bbox[1] })
    const northeast = lonLatToMercator({ longitude: bbox[2], latitude: bbox[3] })
    const range = bboxToCellRange(
      {
        minX: southwest.x,
        minY: southwest.y,
        maxX: northeast.x,
        maxY: northeast.y
      },
      this.config.baseCellMeters
    )
    return this.getCellsInRange(
      range.minCellX,
      range.minCellY,
      range.maxCellX,
      range.maxCellY,
      datum
    )
  }

  listSoundings(options: {
    bbox?: [number, number, number, number]
    fromMs?: number
    toMs?: number
    qcState?: QcState
    limit: number
  }): Record<string, unknown>[] {
    const conditions = ['q.model_version=?']
    const params: Array<string | number> = [MODEL_VERSION]
    if (options.bbox) {
      conditions.push('r.lon_e7 BETWEEN ? AND ?', 'r.lat_e7 BETWEEN ? AND ?')
      params.push(
        Math.round(options.bbox[0] * 1e7),
        Math.round(options.bbox[2] * 1e7),
        Math.round(options.bbox[1] * 1e7),
        Math.round(options.bbox[3] * 1e7)
      )
    }
    if (options.fromMs !== undefined) {
      conditions.push('r.observed_at_ms>=?')
      params.push(options.fromMs)
    }
    if (options.toMs !== undefined) {
      conditions.push('r.observed_at_ms<=?')
      params.push(options.toMs)
    }
    if (options.qcState) {
      conditions.push('q.qc_state=?')
      params.push(options.qcState)
    }
    params.push(options.limit)
    const rows = this.db
      .prepare(`
        SELECT r.id, r.observed_at_ms, r.origin, r.context,
          r.lat_e7, r.lon_e7, r.position_source,
          r.depth_raw_mm, r.depth_reference, r.depth_source,
          r.surface_to_keel_mm, r.surface_to_transducer_mm,
          r.tide_height_mm, r.tide_datum, r.tide_station_id, r.tide_station_name,
          r.datum_depth_mm, r.vertical_sigma_mm, r.pass_id,
          r.aggregation_kind, r.sample_count, r.rejected_sample_count,
          r.window_start_ms, r.window_end_ms,
          q.qc_state, q.reasons_json
        FROM raw_soundings r
        JOIN qc_classifications q ON q.sounding_id=r.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.observed_at_ms DESC
        LIMIT ?
      `)
      .all(...params) as unknown as Record<string, unknown>[]
    return rows.map((row) => ({
      id: row.id,
      observedAt: new Date(Number(row.observed_at_ms)).toISOString(),
      origin: row.origin,
      context: row.context,
      position: { latitude: Number(row.lat_e7) / 1e7, longitude: Number(row.lon_e7) / 1e7 },
      positionSource: row.position_source,
      rawDepthM: Number(row.depth_raw_mm) / 1000,
      depthReference: row.depth_reference,
      depthSource: row.depth_source,
      surfaceToKeelM: millimetersToOptionalMeters(row.surface_to_keel_mm),
      surfaceToTransducerM: millimetersToOptionalMeters(row.surface_to_transducer_mm),
      belowSurfaceDepthM: belowSurfaceDepth(row),
      tideHeightM: Number(row.tide_height_mm) / 1000,
      datum: row.tide_datum,
      tideStationId: row.tide_station_id,
      tideStationName: row.tide_station_name,
      datumDepthM: Number(row.datum_depth_mm) / 1000,
      verticalSigmaM: Number(row.vertical_sigma_mm) / 1000,
      passId: row.pass_id,
      aggregationKind: row.aggregation_kind,
      sampleCount: Number(row.sample_count),
      rejectedSampleCount: Number(row.rejected_sample_count),
      windowStart: new Date(Number(row.window_start_ms)).toISOString(),
      windowEnd: new Date(Number(row.window_end_ms)).toISOString(),
      qcState: row.qc_state,
      qcReasons: parseJsonArray(row.reasons_json)
    }))
  }

  listChanges(sinceMs: number, datum: string, limit = 1000): SurfaceCell[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM surface_cells
        WHERE datum=? AND model_version=? AND updated_at_ms>=? AND change_state!='stable'
        ORDER BY updated_at_ms DESC LIMIT ?
      `)
      .all(datum, MODEL_VERSION, sinceMs, limit) as unknown as Record<string, unknown>[]
    return rows.map((row) => this.mapCell(row))
  }

  stats(): StoreStats {
    const counts = this.db
      .prepare(`
        SELECT
          (SELECT count(*) FROM raw_soundings) AS soundings,
          (SELECT count(*) FROM qc_classifications WHERE model_version=? AND qc_state='accepted') AS accepted,
          (SELECT count(*) FROM qc_classifications WHERE model_version=? AND qc_state='quarantined') AS quarantined,
          (SELECT count(*) FROM surface_cells WHERE model_version=?) AS cells,
          (SELECT coalesce(sum(sample_count),0) FROM raw_soundings) AS source_samples,
          (SELECT coalesce(sum(rejected_sample_count),0) FROM raw_soundings) AS rejected_stationary_samples,
          (SELECT max(observed_at_ms) FROM raw_soundings) AS latest
      `)
      .get(MODEL_VERSION, MODEL_VERSION, MODEL_VERSION) as Record<string, unknown>
    const boundsRow = this.db
      .prepare('SELECT min(lon_e7) min_lon, min(lat_e7) min_lat, max(lon_e7) max_lon, max(lat_e7) max_lat FROM raw_soundings')
      .get() as Record<string, unknown>
    const stats: StoreStats = {
      soundings: Number(counts.soundings),
      sourceSamples: Number(counts.source_samples),
      rejectedStationarySamples: Number(counts.rejected_stationary_samples),
      accepted: Number(counts.accepted),
      quarantined: Number(counts.quarantined),
      cells: Number(counts.cells)
    }
    if (counts.latest !== null && counts.latest !== undefined) stats.latestObservationMs = Number(counts.latest)
    if (boundsRow.min_lon !== null && boundsRow.min_lon !== undefined) {
      stats.bounds = [
        Number(boundsRow.min_lon) / 1e7,
        Number(boundsRow.min_lat) / 1e7,
        Number(boundsRow.max_lon) / 1e7,
        Number(boundsRow.max_lat) / 1e7
      ]
    }
    return stats
  }

  revision(): number {
    const row = this.db
      .prepare('SELECT coalesce(max(updated_at_ms),0) AS revision FROM surface_cells')
      .get() as { revision: number }
    return Number(row.revision)
  }

  cellBounds(cell: SurfaceCell): [number, number, number, number] {
    const bounds = hexCellMercatorBounds(cell.cellX, cell.cellY, this.config.baseCellMeters)
    const min = mercatorToLonLat(bounds.minX, bounds.minY)
    const max = mercatorToLonLat(bounds.maxX, bounds.maxY)
    return [min.longitude, min.latitude, max.longitude, max.latitude]
  }

  cellPolygon(cell: SurfaceCell): Array<[number, number]> {
    const ring = hexCellVertices(cell.cellX, cell.cellY, this.config.baseCellMeters).map(
      (vertex): [number, number] => {
        const position = mercatorToLonLat(vertex.x, vertex.y)
        return [position.longitude, position.latitude]
      }
    )
    const first = ring[0]
    if (first) ring.push(first)
    return ring
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_soundings (
        id INTEGER PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        observed_at_ms INTEGER NOT NULL,
        ingested_at_ms INTEGER NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('live','history')),
        context TEXT NOT NULL,
        track_id TEXT NOT NULL,
        pass_id TEXT NOT NULL,
        lat_e7 INTEGER NOT NULL,
        lon_e7 INTEGER NOT NULL,
        cell_x INTEGER NOT NULL,
        cell_y INTEGER NOT NULL,
        position_source TEXT NOT NULL,
        depth_raw_mm INTEGER NOT NULL,
        depth_reference TEXT NOT NULL,
        depth_source TEXT NOT NULL,
        surface_to_keel_mm INTEGER,
        surface_to_transducer_mm INTEGER,
        tide_height_mm INTEGER NOT NULL,
        tide_datum TEXT NOT NULL,
        tide_station_id TEXT NOT NULL,
        tide_station_name TEXT NOT NULL,
        tide_method TEXT NOT NULL,
        tide_source TEXT NOT NULL,
        tide_observed_at_ms INTEGER NOT NULL,
        datum_depth_mm INTEGER NOT NULL,
        vertical_sigma_mm INTEGER NOT NULL,
        sog_mmps INTEGER,
        cog_true_urad INTEGER,
        heave_mm INTEGER,
        input_time_skew_ms INTEGER NOT NULL,
        aggregation_kind TEXT NOT NULL DEFAULT 'point' CHECK(aggregation_kind IN ('point','stationary_window')),
        sample_count INTEGER NOT NULL DEFAULT 1,
        rejected_sample_count INTEGER NOT NULL DEFAULT 0,
        window_start_ms INTEGER NOT NULL DEFAULT 0,
        window_end_ms INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS raw_time_idx ON raw_soundings(observed_at_ms);
      CREATE INDEX IF NOT EXISTS raw_cell_idx ON raw_soundings(cell_x, cell_y, tide_datum);
      CREATE INDEX IF NOT EXISTS raw_position_idx ON raw_soundings(lon_e7, lat_e7);
      CREATE TABLE IF NOT EXISTS qc_classifications (
        sounding_id INTEGER NOT NULL REFERENCES raw_soundings(id),
        model_version INTEGER NOT NULL,
        qc_state TEXT NOT NULL CHECK(qc_state IN ('accepted','quarantined','rejected')),
        reasons_json TEXT NOT NULL,
        classified_at_ms INTEGER NOT NULL,
        PRIMARY KEY(sounding_id, model_version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS qc_state_idx ON qc_classifications(model_version, qc_state);
      CREATE TABLE IF NOT EXISTS surface_cells (
        cell_x INTEGER NOT NULL,
        cell_y INTEGER NOT NULL,
        datum TEXT NOT NULL,
        model_version INTEGER NOT NULL,
        robust_depth_mm INTEGER NOT NULL,
        render_depth_mm INTEGER NOT NULL,
        conservative_depth_mm INTEGER NOT NULL,
        vertical_sigma_mm INTEGER NOT NULL,
        confidence_base REAL NOT NULL,
        sounding_count INTEGER NOT NULL,
        observation_count INTEGER NOT NULL DEFAULT 0,
        pass_count INTEGER NOT NULL,
        source_count INTEGER NOT NULL,
        oldest_at_ms INTEGER NOT NULL,
        newest_at_ms INTEGER NOT NULL,
        change_state TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY(cell_x, cell_y, datum, model_version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS surface_change_idx ON surface_cells(datum, change_state, updated_at_ms);
      CREATE TABLE IF NOT EXISTS surface_cell_history (
        id INTEGER PRIMARY KEY,
        cell_x INTEGER NOT NULL,
        cell_y INTEGER NOT NULL,
        datum TEXT NOT NULL,
        model_version INTEGER NOT NULL,
        previous_depth_mm INTEGER NOT NULL,
        new_depth_mm INTEGER NOT NULL,
        changed_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bathymetry_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
    this.ensureColumn('raw_soundings', 'aggregation_kind', "TEXT NOT NULL DEFAULT 'point'")
    this.ensureColumn('raw_soundings', 'sample_count', 'INTEGER NOT NULL DEFAULT 1')
    this.ensureColumn('raw_soundings', 'rejected_sample_count', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('raw_soundings', 'window_start_ms', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('raw_soundings', 'window_end_ms', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('surface_cells', 'observation_count', 'INTEGER NOT NULL DEFAULT 0')
    this.db.exec(`
      UPDATE raw_soundings SET window_start_ms=observed_at_ms WHERE window_start_ms=0;
      UPDATE raw_soundings SET window_end_ms=observed_at_ms WHERE window_end_ms=0;
    `)
    this.migrateGridIfNeeded()
    this.db.exec('PRAGMA user_version=3;')
  }

  private migrateGridIfNeeded(): void {
    const expected = `${GRID_VERSION}:${this.config.baseCellMeters}`
    const metadata = this.db
      .prepare("SELECT value FROM bathymetry_metadata WHERE key='grid_layout'")
      .get() as { value: string } | undefined
    if (metadata?.value === expected) return

    const rows = this.db
      .prepare('SELECT id, lat_e7, lon_e7 FROM raw_soundings')
      .all() as unknown as Array<{ id: number; lat_e7: number; lon_e7: number }>
    const update = this.db.prepare('UPDATE raw_soundings SET cell_x=?, cell_y=? WHERE id=?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const cell = cellForPosition(
          { latitude: row.lat_e7 / 1e7, longitude: row.lon_e7 / 1e7 },
          this.config.baseCellMeters
        )
        update.run(cell.x, cell.y, row.id)
      }
      this.db.prepare('DELETE FROM qc_classifications WHERE model_version=?').run(MODEL_VERSION)
      this.db.prepare('DELETE FROM surface_cells WHERE model_version=?').run(MODEL_VERSION)
      this.db.prepare('DELETE FROM surface_cell_history WHERE model_version=?').run(MODEL_VERSION)
      this.db
        .prepare(`
          INSERT INTO bathymetry_metadata (key, value) VALUES ('grid_layout', ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `)
        .run(expected)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string
    }>
    if (!columns.some((candidate) => candidate.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  private rawParameters(s: SoundingInput, cellX: number, cellY: number): Array<string | number | null> {
    const fingerprint = createHash('sha256')
      .update(
        [
          s.context,
          s.observedAtMs,
          Math.round(s.latitude * 1e7),
          Math.round(s.longitude * 1e7),
          s.depthSource,
          Math.round(s.rawDepthM * 1000)
        ].join('|')
      )
      .digest('hex')
    return [
      fingerprint,
      s.observedAtMs,
      s.ingestedAtMs,
      s.origin,
      s.context,
      s.trackId,
      s.passId,
      Math.round(s.latitude * 1e7),
      Math.round(s.longitude * 1e7),
      cellX,
      cellY,
      s.positionSource,
      Math.round(s.rawDepthM * 1000),
      s.depthReference,
      s.depthSource,
      toMillimeters(s.surfaceToKeelM),
      toMillimeters(s.surfaceToTransducerM),
      Math.round(s.tideHeightM * 1000),
      s.tideDatum,
      s.tideStationId,
      s.tideStationName,
      s.tideMethod,
      s.tideSource,
      s.tideObservedAtMs,
      Math.round(s.datumDepthM * 1000),
      Math.max(1, Math.round(s.verticalSigmaM * 1000)),
      toScaled(s.sogMps, 1000),
      toScaled(s.cogTrueRad, 1e6),
      toMillimeters(s.heaveM),
      Math.round(s.inputTimeSkewMs),
      s.aggregationKind ?? 'point',
      Math.max(1, Math.round(s.sampleCount ?? 1)),
      Math.max(0, Math.round(s.rejectedSampleCount ?? 0)),
      Math.round(s.windowStartMs ?? s.observedAtMs),
      Math.round(s.windowEndMs ?? s.observedAtMs)
    ]
  }

  private rebuildCell(cellX: number, cellY: number, datum: string): void {
    const rows = this.selectRawCell.all(cellX, cellY, datum) as unknown as RawCellRow[]
    if (rows.length === 0) return
    const existing = this.selectExistingCell.get(
      cellX,
      cellY,
      datum,
      MODEL_VERSION
    ) as ExistingCellRow | undefined
    const passes = aggregatePasses(rows)
    const clusters = clusterPasses(passes, this.config.outlierFloorM)
    const active = selectActiveCluster(clusters, existing, this.config)
    const otherClusters = clusters.filter((cluster) => cluster !== active)
    const shallowCandidate = otherClusters
      .filter((cluster) => cluster.centerM < active.centerM - this.config.outlierFloorM)
      .sort((a, b) => a.centerM - b.centerM)[0]
    const deepCandidate = otherClusters
      .filter(
        (cluster) =>
          cluster.newestAtMs > active.newestAtMs &&
          cluster.centerM > active.centerM + this.config.outlierFloorM
      )
      .sort((a, b) => b.newestAtMs - a.newestAtMs)[0]

    let changeState: ChangeState = 'stable'
    const changedFromExisting =
      existing !== undefined &&
      Math.abs(active.centerM - existing.robust_depth_mm / 1000) >= this.config.outlierFloorM
    if (changedFromExisting && clusterIsQualified(active, this.config)) changeState = 'confirmed'
    else if (shallowCandidate) changeState = 'suspected_shoaling'
    else if (deepCandidate) changeState = 'candidate_deepening'

    const activeIds = new Set(active.passes.flatMap((pass) => pass.soundingIds))
    const now = Date.now()
    for (const row of rows) {
      this.insertClassification.run(
        row.id,
        MODEL_VERSION,
        activeIds.has(row.id) ? 'accepted' : 'quarantined',
        JSON.stringify(activeIds.has(row.id) ? [] : ['local_depth_cluster_disagreement']),
        now
      )
    }

    const activeRows = rows.filter((row) => activeIds.has(row.id))
    const passDepths = active.passes.map((pass) => pass.depthM)
    const uncertaintyRows = shallowCandidate
      ? rows.filter((row) => shallowCandidate.passes.some((pass) => pass.soundingIds.includes(row.id)))
      : activeRows
    const uncertaintyPasses = shallowCandidate ? shallowCandidate.passes : active.passes
    const measurementSigmaM = median(uncertaintyRows.map((row) => row.vertical_sigma_mm / 1000))
    const passRepeatSigmaM = robustSigma(uncertaintyPasses.map((pass) => pass.depthM))
    const withinVisitSigmaM = median(
      uncertaintyPasses.map((pass) => {
        const passRows = uncertaintyRows.filter((row) => row.pass_id === pass.passId)
        return robustSigma(passRows.map((row) => row.datum_depth_mm / 1000))
      })
    )
    // A single sounding's sensor, offset, and tide terms are shared systematic uncertainty and
    // must not vanish merely because more samples arrived. Repeatability across independent passes
    // is different: the uncertainty of the cell mean improves with the number of passes. Keep the
    // systematic floor, then reduce only the independent pass and within-pass components.
    const independentPasses = Math.max(1, uncertaintyPasses.length)
    const sigmaM = Math.sqrt(
      measurementSigmaM ** 2 +
        passRepeatSigmaM ** 2 / independentPasses +
        withinVisitSigmaM ** 2 / independentPasses
    )
    const renderDepthM = shallowCandidate ? shallowCandidate.centerM : active.centerM
    const conservativeDepthM = renderDepthM - 1.645 * sigmaM
    const sourceCount = new Set(activeRows.map((row) => row.depth_source)).size
    const observationEvidence = 1 - Math.exp(-activeRows.length / 4)
    const visitDiversity = 0.45 + 0.55 * Math.min(1, active.passes.length / 3)
    const calculatedConfidence = weightedGeometricMean([
      { value: Math.exp(-measurementSigmaM / 1), weight: 2 },
      { value: observationEvidence, weight: 1 },
      { value: visitDiversity, weight: 2 },
      { value: Math.exp(-passRepeatSigmaM / 0.5), weight: 2 },
      { value: Math.exp(-withinVisitSigmaM / 0.5), weight: 1 },
      { value: sourceCount >= 2 ? 1 : 0.7, weight: 1 }
    ])
    const confidence = Math.min(
      calculatedConfidence,
      evidenceConfidenceCap(activeRows.length, active.passes.length, sourceCount)
    )
    const oldestAtMs = Math.min(...activeRows.map((row) => row.observed_at_ms))
    const newestAtMs = Math.max(...activeRows.map((row) => row.observed_at_ms))

    if (changedFromExisting && changeState === 'confirmed' && existing) {
      this.db
        .prepare(`
          INSERT INTO surface_cell_history (
            cell_x, cell_y, datum, model_version, previous_depth_mm, new_depth_mm, changed_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          cellX,
          cellY,
          datum,
          MODEL_VERSION,
          existing.robust_depth_mm,
          Math.round(active.centerM * 1000),
          now
        )
    }

    this.upsertCell.run(
      cellX,
      cellY,
      datum,
      MODEL_VERSION,
      Math.round(active.centerM * 1000),
      Math.round(renderDepthM * 1000),
      Math.round(conservativeDepthM * 1000),
      Math.max(1, Math.round(sigmaM * 1000)),
      confidence,
      activeRows.reduce((sum, row) => sum + row.sample_count, 0),
      activeRows.length,
      active.passes.length,
      sourceCount,
      oldestAtMs,
      newestAtMs,
      changeState,
      now
    )
  }

  private mapCell(row: Record<string, unknown>): SurfaceCell {
    const newestAtMs = Number(row.newest_at_ms)
    const ageDays = Math.max(0, Date.now() - newestAtMs) / DAY_MS
    const recency = 2 ** (-ageDays / this.config.recencyHalfLifeDays)
    const observationCount = Number(row.observation_count)
    const passCount = Number(row.pass_count)
    const sourceCount = Number(row.source_count)
    return {
      cellX: Number(row.cell_x),
      cellY: Number(row.cell_y),
      datum: String(row.datum),
      robustDepthM: Number(row.robust_depth_mm) / 1000,
      renderDepthM: Number(row.render_depth_mm) / 1000,
      conservativeDepthM: Number(row.conservative_depth_mm) / 1000,
      verticalSigmaM: Number(row.vertical_sigma_mm) / 1000,
      confidence: Math.min(1, Number(row.confidence_base) * recency),
      confidenceReasons: evidenceConfidenceReasons(observationCount, passCount, sourceCount),
      soundingCount: Number(row.sounding_count),
      observationCount,
      passCount,
      sourceCount,
      oldestAtMs: Number(row.oldest_at_ms),
      newestAtMs,
      changeState: String(row.change_state) as ChangeState,
      updatedAtMs: Number(row.updated_at_ms)
    }
  }

  private applyNeighborhoodConfidence(cells: SurfaceCell[]): SurfaceCell[] {
    const byCell = new Map(cells.map((cell) => [`${cell.cellX}:${cell.cellY}`, cell]))
    return cells.map((cell) => {
      const neighbors = AXIAL_NEIGHBORS
        .map(([x, y]) => byCell.get(`${cell.cellX + x}:${cell.cellY + y}`))
        .filter((neighbor): neighbor is SurfaceCell => neighbor !== undefined)
      const strongNeighbors = neighbors.filter(
        (neighbor) => neighbor.observationCount >= 3 && neighbor.passCount >= 2 && neighbor.confidence >= 0.55
      )
      const result: SurfaceCell = {
        ...cell,
        confidenceReasons: [...(cell.confidenceReasons ?? [])],
        neighborSupportCount: strongNeighbors.length
      }
      if (strongNeighbors.length < 2 || (cell.observationCount > 2 && cell.passCount > 1)) return result

      const neighborDepths = strongNeighbors.map((neighbor) => neighbor.robustDepthM)
      const localDepthM = median(neighborDepths)
      const neighborSpreadM = robustSigma(neighborDepths)
      const deltaM = Math.abs(cell.robustDepthM - localDepthM)
      const toleranceM = Math.max(this.config.outlierFloorM * 1.5, neighborSpreadM * 1.5)
      result.neighborDepthDeltaM = deltaM
      if (deltaM <= toleranceM) return result

      const weakEvidenceCap = cell.observationCount <= 1 ? 0.12 : cell.observationCount <= 2 ? 0.22 : 0.3
      result.confidence = Math.min(result.confidence, weakEvidenceCap)
      result.confidenceReasons?.push('neighbor_depth_disagreement')
      return result
    })
  }
}

function evidenceConfidenceCap(observationCount: number, passCount: number, sourceCount: number): number {
  let cap = 1
  if (observationCount <= 1) cap = Math.min(cap, 0.25)
  else if (observationCount === 2) cap = Math.min(cap, 0.4)
  if (passCount <= 1) cap = Math.min(cap, 0.35)
  else if (passCount === 2) cap = Math.min(cap, 0.6)
  if (sourceCount <= 1) cap = Math.min(cap, 0.75)
  return cap
}

function evidenceConfidenceReasons(observationCount: number, passCount: number, sourceCount: number): string[] {
  const reasons: string[] = []
  if (observationCount <= 1) reasons.push('single_observation')
  else if (observationCount === 2) reasons.push('only_two_observations')
  if (passCount <= 1) reasons.push('single_pass')
  else if (passCount === 2) reasons.push('only_two_passes')
  if (sourceCount <= 1) reasons.push('single_source')
  return reasons
}

function aggregatePasses(rows: readonly RawCellRow[]): PassEstimate[] {
  const byPass = new Map<string, RawCellRow[]>()
  for (const row of rows) {
    const group = byPass.get(row.pass_id) ?? []
    group.push(row)
    byPass.set(row.pass_id, group)
  }
  return [...byPass.entries()].map(([passId, passRows]) => ({
    passId,
    depthM: median(passRows.map((row) => row.datum_depth_mm / 1000)),
    newestAtMs: Math.max(...passRows.map((row) => row.observed_at_ms)),
    oldestAtMs: Math.min(...passRows.map((row) => row.observed_at_ms)),
    soundingIds: passRows.map((row) => row.id)
  }))
}

function clusterPasses(passes: readonly PassEstimate[], thresholdM: number): DepthCluster[] {
  const clusters: DepthCluster[] = []
  for (const pass of [...passes].sort((a, b) => a.depthM - b.depthM)) {
    const cluster = clusters.find((candidate) => Math.abs(candidate.centerM - pass.depthM) <= thresholdM)
    if (cluster) {
      cluster.passes.push(pass)
      cluster.centerM = median(cluster.passes.map((item) => item.depthM))
      cluster.newestAtMs = Math.max(cluster.newestAtMs, pass.newestAtMs)
      cluster.oldestAtMs = Math.min(cluster.oldestAtMs, pass.oldestAtMs)
    } else {
      clusters.push({
        passes: [pass],
        centerM: pass.depthM,
        newestAtMs: pass.newestAtMs,
        oldestAtMs: pass.oldestAtMs
      })
    }
  }
  return clusters
}

function selectActiveCluster(
  clusters: readonly DepthCluster[],
  existing: ExistingCellRow | undefined,
  config: BathymetryConfig
): DepthCluster {
  if (clusters.length === 0) throw new Error('Cannot select a cluster from no observations')
  if (existing) {
    const previousDepthM = existing.robust_depth_mm / 1000
    const baseline = [...clusters].sort(
      (a, b) => Math.abs(a.centerM - previousDepthM) - Math.abs(b.centerM - previousDepthM)
    )[0]
    if (!baseline) throw new Error('Missing baseline cluster')
    const qualifiedNewer = clusters
      .filter(
        (cluster) =>
          cluster !== baseline &&
          cluster.newestAtMs > baseline.newestAtMs &&
          clusterIsQualified(cluster, config)
      )
      .sort((a, b) => b.newestAtMs - a.newestAtMs)
    return qualifiedNewer[0] ?? baseline
  }
  return [...clusters].sort(
    (a, b) => b.passes.length - a.passes.length || b.newestAtMs - a.newestAtMs
  )[0] as DepthCluster
}

function clusterIsQualified(cluster: DepthCluster, config: BathymetryConfig): boolean {
  return (
    cluster.passes.length >= config.changeMinimumPasses &&
    cluster.newestAtMs - cluster.oldestAtMs >= config.changeMinimumDays * DAY_MS
  )
}

function toMillimeters(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value * 1000)
}

function millimetersToOptionalMeters(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value) / 1000
}

function belowSurfaceDepth(row: Record<string, unknown>): number | undefined {
  const rawDepthM = Number(row.depth_raw_mm) / 1000
  if (row.depth_reference === 'belowSurface') return rawDepthM
  const offset =
    row.depth_reference === 'belowKeel'
      ? millimetersToOptionalMeters(row.surface_to_keel_mm)
      : row.depth_reference === 'belowTransducer'
        ? millimetersToOptionalMeters(row.surface_to_transducer_mm)
        : undefined
  return offset === undefined ? undefined : rawDepthM + offset
}

function toScaled(value: number | undefined, scale: number): number | null {
  return value === undefined ? null : Math.round(value * scale)
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
