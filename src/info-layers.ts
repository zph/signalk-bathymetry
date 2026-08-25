import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ResourceProvider } from '@signalk/server-api'
import { revisionFor, type DepthDisplayUnits } from './depth-units'
import { TILE_STYLE_REVISION } from './tiles'
import type { BathymetryConfig } from './types'

const DATUM_INFO_ID = 'signalk-bathymetry-datum-live'
const WATER_INFO_ID = 'signalk-bathymetry-water-live'
export const INFO_LAYER_REFRESH_MS = 600_000

export function createInfoLayerProvider(
  config: BathymetryConfig,
  getDepthUnits: () => DepthDisplayUnits,
  preferencesPath?: string
): ResourceProvider {
  const preferences = loadPreferences(preferencesPath)
  const resources = (): Record<string, unknown> => {
    const units = getDepthUnits()
    return {
      [DATUM_INFO_ID]: infoLayer(
        `Local Bathymetry — ${config.targetDatum} (${units.symbol})`,
        'datum',
        config,
        units,
        preferences[DATUM_INFO_ID]?.opacity ?? 1
      ),
      [WATER_INFO_ID]: infoLayer(
        `Local Bathymetry — Tide-adjusted live (${units.symbol})`,
        'water',
        config,
        units,
        preferences[WATER_INFO_ID]?.opacity ?? 1
      )
    }
  }
  return {
    type: 'infolayers',
    methods: {
      listResources: async () => resources(),
      getResource: async (id, property) => {
        const resource = resources()[id]
        if (!resource || typeof resource !== 'object') {
          throw new Error(`Unknown bathymetry information layer: ${id}`)
        }
        if (!property) return resource
        const value = readProperty(resource as Record<string, unknown>, property)
        if (value === undefined) throw new Error(`Unknown information-layer property: ${property}`)
        return { value }
      },
      setResource: async (id, value) => {
        if (id !== DATUM_INFO_ID && id !== WATER_INFO_ID) {
          throw new Error(`Unknown bathymetry information layer: ${id}`)
        }
        const opacity = resourceOpacity(value)
        if (opacity === undefined) return
        preferences[id] = { opacity }
        savePreferences(preferencesPath, preferences)
      },
      deleteResource: async () => {
        throw new Error('Bathymetry information layers are read-only')
      }
    }
  }
}

function infoLayer(
  name: string,
  mode: 'datum' | 'water',
  config: BathymetryConfig,
  units: DepthDisplayUnits,
  opacity: number
): Record<string, unknown> {
  return {
    type: 'InfoLayer',
    name,
    description:
      mode === 'water'
        ? `Conservative tide-adjusted local depth in ${units.symbol}; enable this or the datum layer, not both; refreshes every 10 minutes; not for primary navigation`
        : `Conservative local depth below ${config.targetDatum} in ${units.symbol}; enable this or the tide-adjusted layer, not both; refreshes every 10 minutes; not for primary navigation`,
    values: {
      sourceType: 'xyz',
      url: `/plugins/signalk-bathymetry/tiles/{z}/{x}/{y}.png?layer=depth&mode=${mode}&units=${revisionFor(units)}&style=${TILE_STYLE_REVISION}`,
      layers: [],
      opacity,
      minZoom: config.minZoom,
      maxZoom: config.maxZoom,
      refreshInterval: INFO_LAYER_REFRESH_MS
    }
  }
}

interface InfoLayerPreferences {
  [id: string]: { opacity: number } | undefined
}

function resourceOpacity(value: Record<string, unknown>): number | undefined {
  const values = value.values
  const candidate =
    values && typeof values === 'object'
      ? (values as Record<string, unknown>).opacity
      : value.opacity
  if (candidate === undefined) return undefined
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new Error('Bathymetry information-layer opacity must be a number')
  }
  return Math.max(0, Math.min(1, candidate))
}

function loadPreferences(path: string | undefined): InfoLayerPreferences {
  if (!path) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const result: InfoLayerPreferences = {}
    for (const id of [DATUM_INFO_ID, WATER_INFO_ID]) {
      const value = parsed[id]
      if (!value || typeof value !== 'object') continue
      const opacity = (value as Record<string, unknown>).opacity
      if (typeof opacity === 'number' && Number.isFinite(opacity)) {
        result[id] = { opacity: Math.max(0, Math.min(1, opacity)) }
      }
    }
    return result
  } catch {
    return {}
  }
}

function savePreferences(path: string | undefined, preferences: InfoLayerPreferences): void {
  if (!path) return
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function readProperty(object: Record<string, unknown>, property: string): unknown {
  let value: unknown = object
  for (const segment of property.split('.')) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}
