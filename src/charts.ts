import type { ResourceProvider } from '@signalk/server-api'
import type { BathymetryStore } from './store'
import type { BathymetryConfig } from './types'
import { revisionFor, type DepthDisplayUnits } from './depth-units'

const DATUM_ID = 'signalk-bathymetry-datum'
const WATER_ID = 'signalk-bathymetry-water-now'

export function createChartProvider(
  store: BathymetryStore,
  config: BathymetryConfig,
  getDepthUnits: () => DepthDisplayUnits
): ResourceProvider {
  const resources = (): Record<string, unknown> => {
    const units = getDepthUnits()
    return {
      [DATUM_ID]: chartResource(
        DATUM_ID,
        `Local Bathymetry — ${config.targetDatum} (${units.symbol})`,
        'datum',
        store,
        config,
        units
      ),
      [WATER_ID]: chartResource(
        WATER_ID,
        `Local Bathymetry — Tide-adjusted now (${units.symbol})`,
        'water',
        store,
        config,
        units
      )
    }
  }
  return {
    type: 'charts',
    methods: {
      listResources: async () => resources(),
      getResource: async (id, property) => {
        const resource = resources()[id]
        if (!resource || typeof resource !== 'object') throw new Error(`Unknown chart resource: ${id}`)
        if (!property) return resource
        const value = readProperty(resource as Record<string, unknown>, property)
        if (value === undefined) throw new Error(`Unknown chart property: ${property}`)
        return { value }
      },
      setResource: async () => {
        throw new Error('Bathymetry chart resources are read-only')
      },
      deleteResource: async () => {
        throw new Error('Bathymetry chart resources are read-only')
      }
    }
  }
}

function chartResource(
  identifier: string,
  name: string,
  mode: 'datum' | 'water',
  store: BathymetryStore,
  config: BathymetryConfig,
  units: DepthDisplayUnits
): Record<string, unknown> {
  const bounds = expandedBounds(store.stats().bounds)
  const tileUrl = `/plugins/signalk-bathymetry/tiles/{z}/{x}/{y}.png?layer=depth&mode=${mode}&units=${revisionFor(units)}`
  return {
    identifier,
    name,
    description:
      mode === 'datum'
        ? `Crowdsourced conservative depth below ${config.targetDatum}, labeled in ${units.symbol}; enable this or the tide-adjusted chart, not both; not for primary navigation`
        : `Estimated conservative water depth using the current ${config.targetDatum} tide, labeled in ${units.symbol}; enable this or the datum chart, not both; not for primary navigation`,
    type: 'tilelayer',
    format: 'png',
    chartFormat: 'png',
    minzoom: config.minZoom,
    maxzoom: config.maxZoom,
    bounds,
    url: tileUrl,
    tilemapUrl: tileUrl,
    layers: [],
    chartLayers: []
  }
}

function expandedBounds(bounds: [number, number, number, number] | undefined): number[] {
  if (!bounds) return [-180, -85, 180, 85]
  const [west, south, east, north] = bounds
  const margin = 0.01
  return [west - margin, south - margin, east + margin, north + margin]
}

function readProperty(object: Record<string, unknown>, property: string): unknown {
  let value: unknown = object
  for (const segment of property.split('.')) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}
