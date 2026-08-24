import type { ResourceProvider } from '@signalk/server-api'
import { revisionFor, type DepthDisplayUnits } from './depth-units'
import type { BathymetryConfig } from './types'

const DATUM_INFO_ID = 'signalk-bathymetry-datum-live'
const WATER_INFO_ID = 'signalk-bathymetry-water-live'
export const INFO_LAYER_REFRESH_MS = 600_000

export function createInfoLayerProvider(
  config: BathymetryConfig,
  getDepthUnits: () => DepthDisplayUnits
): ResourceProvider {
  const resources = (): Record<string, unknown> => {
    const units = getDepthUnits()
    return {
      [DATUM_INFO_ID]: infoLayer(
        `Local Bathymetry — ${config.targetDatum} (${units.symbol})`,
        'datum',
        config,
        units
      ),
      [WATER_INFO_ID]: infoLayer(
        `Local Bathymetry — Tide-adjusted live (${units.symbol})`,
        'water',
        config,
        units
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
      setResource: async () => {
        throw new Error('Bathymetry information layers are read-only')
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
  units: DepthDisplayUnits
): Record<string, unknown> {
  return {
    type: 'InfoLayer',
    name,
    description:
      mode === 'water'
        ? `Conservative tide-adjusted local depth in ${units.symbol}; refreshes every 10 minutes; not for primary navigation`
        : `Conservative local depth below ${config.targetDatum} in ${units.symbol}; refreshes every 10 minutes; not for primary navigation`,
    values: {
      sourceType: 'xyz',
      url: `/plugins/signalk-bathymetry/tiles/{z}/{x}/{y}.png?layer=depth&mode=${mode}&units=${revisionFor(units)}`,
      layers: [],
      opacity: 1,
      minZoom: config.minZoom,
      maxZoom: config.maxZoom,
      refreshInterval: INFO_LAYER_REFRESH_MS
    }
  }
}

function readProperty(object: Record<string, unknown>, property: string): unknown {
  let value: unknown = object
  for (const segment of property.split('.')) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}
