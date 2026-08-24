import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ServerAPI } from '@signalk/server-api'

export interface DepthDisplayUnits {
  targetUnit: string
  symbol: string
  decimals: number
  metersToDisplayFactor: number
  presetName: string
  resolvedAtMs: number
}

export interface DepthDisplayUnitStatus extends DepthDisplayUnits {
  source: 'signalk' | 'cache' | 'fallback'
  revision: string
}

export const METRIC_DEPTH_UNITS: DepthDisplayUnits = {
  targetUnit: 'm',
  symbol: 'm',
  decimals: 1,
  metersToDisplayFactor: 1,
  presetName: 'Metric fallback',
  resolvedAtMs: 0
}

export class DepthUnitPreferences {
  private units: DepthDisplayUnits
  private source: DepthDisplayUnitStatus['source']
  private timer: NodeJS.Timeout | undefined
  private attempts = 0

  constructor(
    private readonly app: ServerAPI,
    private readonly cachePath: string
  ) {
    const cached = readCachedUnits(cachePath)
    this.units = cached ?? METRIC_DEPTH_UNITS
    this.source = cached ? 'cache' : 'fallback'
  }

  start(): void {
    this.schedule(1500)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  current(): DepthDisplayUnits {
    return this.units
  }

  convertMeters(valueM: number): number {
    return valueM * this.units.metersToDisplayFactor
  }

  status(): DepthDisplayUnitStatus {
    return { ...this.units, source: this.source, revision: revisionFor(this.units) }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => void this.resolveFromServer(), delayMs)
  }

  private async resolveFromServer(): Promise<void> {
    this.attempts += 1
    try {
      const port = validPort(process.env.EXTERNALPORT) ?? validPort(process.env.PORT) ?? 3000
      const response = await fetch(`http://127.0.0.1:${port}/signalk/v1/unitpreferences/active`, {
        signal: AbortSignal.timeout(2500)
      })
      if (!response.ok) throw new Error(`unit preferences returned HTTP ${response.status}`)
      const units = parseDepthDisplayUnits(await response.json(), Date.now())
      this.units = units
      this.source = 'signalk'
      writeCachedUnits(this.cachePath, units)
      this.app.debug(
        `Bathymetry labels use Signal K depth preference ${units.targetUnit} (${units.symbol})`
      )
    } catch (error) {
      if (this.attempts < 12) {
        this.schedule(1500)
        return
      }
      this.app.error(
        `Unable to resolve Signal K depth units; using ${this.units.targetUnit}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

export function parseDepthDisplayUnits(payload: unknown, resolvedAtMs: number): DepthDisplayUnits {
  if (!payload || typeof payload !== 'object') throw new Error('invalid unit preferences response')
  const preset = payload as Record<string, unknown>
  const categories = preset.categories
  if (!categories || typeof categories !== 'object') throw new Error('unit preferences omit categories')
  const depth = (categories as Record<string, unknown>).depth
  if (!depth || typeof depth !== 'object') throw new Error('unit preferences omit depth')
  const preference = depth as Record<string, unknown>
  const targetUnit = requiredString(preference.targetUnit, 'depth targetUnit')
  const baseUnit = requiredString(preference.baseUnit, 'depth baseUnit')
  if (baseUnit !== 'm') throw new Error(`unsupported depth base unit ${baseUnit}`)
  const factor = conversionFactor(targetUnit, preference.formula)
  return {
    targetUnit,
    symbol: depthSymbol(targetUnit, preference.symbol),
    decimals: displayDecimals(preference.displayFormat),
    metersToDisplayFactor: factor,
    presetName: typeof preset.name === 'string' ? preset.name : 'Signal K active preset',
    resolvedAtMs
  }
}

export function revisionFor(units: DepthDisplayUnits): string {
  return `${units.targetUnit}-${units.metersToDisplayFactor}`.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function conversionFactor(targetUnit: string, formula: unknown): number {
  if (targetUnit === 'm') return 1
  if (typeof formula !== 'string') throw new Error(`depth unit ${targetUnit} omits conversion`)
  const match = /^value\s*([*/])\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.exec(formula.trim())
  if (!match) throw new Error(`depth unit ${targetUnit} has a non-linear conversion`)
  const operand = Number(match[2])
  const factor = match[1] === '*' ? operand : 1 / operand
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('invalid depth conversion factor')
  return factor
}

function displayDecimals(format: unknown): number {
  if (typeof format !== 'string') return 1
  const match = /\.(0+)/.exec(format)
  return match ? Math.min(2, match[1]!.length) : 0
}

function depthSymbol(targetUnit: string, symbol: unknown): string {
  if (targetUnit === 'foot' || targetUnit === 'feet' || targetUnit === 'ft') return 'ft'
  if (targetUnit === 'm' || targetUnit === 'meter' || targetUnit === 'metre') return 'm'
  return typeof symbol === 'string' && symbol.trim() ? symbol.trim() : targetUnit
}

function validPort(value: string | undefined): number | undefined {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid ${label}`)
  return value.trim()
}

function readCachedUnits(cachePath: string): DepthDisplayUnits | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as DepthDisplayUnits
    if (
      typeof parsed.targetUnit !== 'string' ||
      typeof parsed.symbol !== 'string' ||
      !Number.isInteger(parsed.decimals) ||
      !Number.isFinite(parsed.metersToDisplayFactor) ||
      parsed.metersToDisplayFactor <= 0 ||
      typeof parsed.presetName !== 'string' ||
      !Number.isFinite(parsed.resolvedAtMs)
    ) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

function writeCachedUnits(cachePath: string, units: DepthDisplayUnits): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true })
    const temporaryPath = `${cachePath}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(units, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, cachePath)
  } catch {
    // The in-memory preference remains valid even if the optional cache cannot be written.
  }
}
