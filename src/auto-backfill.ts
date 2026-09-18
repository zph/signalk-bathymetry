import type { AutoBackfillStatus, BathymetryConfig, StoreStats } from './types'

const RETRY_DELAYS_MS = [60_000, 300_000]

interface StatusApp {
  debug(message: string): void
  error(message: string): void
  setPluginStatus(message: string): void
}

interface StatsStore {
  stats(): StoreStats
}

interface BackfillRunner {
  isRunning(): boolean
  run(fromMs: number, toMs: number): Promise<{ rows: number; chunks: number }>
}

export class AutoBackfill {
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private current: AutoBackfillStatus

  constructor(
    private readonly app: StatusApp,
    private readonly store: StatsStore,
    private readonly history: BackfillRunner,
    private readonly config: BathymetryConfig
  ) {
    this.current = {
      state: config.autoBackfillWhenEmpty && !config.attitudeCorrection ? 'not_needed' : 'disabled',
      attempts: 0,
      lookbackDays: config.autoBackfillDays
    }
  }

  start(): void {
    if (!this.config.autoBackfillWhenEmpty || this.config.attitudeCorrection) {
      this.current = { ...this.current, state: 'disabled' }
      return
    }
    if (this.store.stats().soundings > 0) {
      this.current = { ...this.current, state: 'not_needed' }
      return
    }
    this.schedule(this.config.autoBackfillDelaySeconds * 1000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  status(): AutoBackfillStatus {
    return { ...this.current }
  }

  async runNow(): Promise<void> {
    if (this.stopped || !this.config.autoBackfillWhenEmpty || this.config.attitudeCorrection) return
    if (this.store.stats().soundings > 0) {
      this.current = withoutNextAttempt({ ...this.current, state: 'not_needed' })
      return
    }
    if (this.history.isRunning()) {
      this.retry('History backfill is already running')
      return
    }

    const toMs = Date.now()
    const fromMs = toMs - this.config.autoBackfillDays * 86_400_000
    this.current = withoutNextAttempt({
      ...this.current,
      state: 'running',
      attempts: this.current.attempts + 1
    })
    this.app.setPluginStatus(
      `Local store empty; importing ${this.config.autoBackfillDays} days from History API`
    )
    try {
      const result = await this.history.run(fromMs, toMs)
      const records = this.store.stats().soundings
      if (records === 0) {
        this.retry(`History API returned ${result.rows} rows but no usable bathymetry records`)
        return
      }
      this.current = {
        state: 'complete',
        attempts: this.current.attempts,
        lookbackDays: this.config.autoBackfillDays,
        completedAtMs: Date.now(),
        importedRows: result.rows,
        importedRecords: records
      }
      this.app.debug(
        `automatic bathymetry backfill complete: rows=${result.rows} records=${records}`
      )
      this.app.setPluginStatus(
        `Automatic ${this.config.autoBackfillDays}-day backfill complete; ${records} stored records`
      )
    } catch (error) {
      this.retry(errorMessage(error))
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    const nextAttemptMs = Date.now() + delayMs
    this.current = { ...this.current, state: 'scheduled', nextAttemptMs }
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.runNow()
    }, delayMs)
  }

  private retry(message: string): void {
    const retryIndex = Math.max(0, this.current.attempts - 1)
    const delayMs = RETRY_DELAYS_MS[retryIndex]
    if (delayMs !== undefined && !this.stopped) {
      this.current = { ...this.current, lastError: message }
      this.app.debug(`automatic bathymetry backfill will retry: ${message}`)
      this.schedule(delayMs)
      return
    }
    this.current = withoutNextAttempt({ ...this.current, state: 'failed', lastError: message })
    this.app.error(`Automatic bathymetry backfill failed: ${message}`)
    this.app.setPluginStatus(`Live capture active; automatic backfill failed: ${message}`)
  }
}

function withoutNextAttempt(status: AutoBackfillStatus): AutoBackfillStatus {
  const copy = { ...status }
  delete copy.nextAttemptMs
  return copy
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
