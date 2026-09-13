import type { ResourceProvider } from '@signalk/server-api'
import type { BathymetryStore } from './store'
import type { BathymetryConfig } from './types'
import type { NoaaCsbStore } from './noaa-csb'
import {
  CELL_SIZE_SCALE_DEFAULT,
  CELL_SIZE_SCALE_MAX,
  CELL_SIZE_SCALE_MIN,
  CELL_SIZE_SCALE_STEP
} from './tiles'

const DATUM_VECTOR_ID = 'signalk-bathymetry-datum-vector'
const NOAA_CSB_VECTOR_ID = 'signalk-bathymetry-noaa-csb-vector'

export function createChartProvider(
  store: BathymetryStore,
  config: BathymetryConfig,
  csbStore?: NoaaCsbStore
): ResourceProvider {
  const resources = (): Record<string, unknown> => {
    const result: Record<string, unknown> = {
      [DATUM_VECTOR_ID]: vectorChartResource(
        DATUM_VECTOR_ID,
        `Local Bathymetry Cells — ${config.targetDatum}`,
        'datum',
        store,
        config,
        true
      )
    }
    if (csbStore) result[NOAA_CSB_VECTOR_ID] = noaaCsbChartResource(csbStore, config)
    return result
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

function noaaCsbChartResource(
  store: NoaaCsbStore,
  config: BathymetryConfig
): Record<string, unknown> {
  const tileUrl = '/plugins/signalk-bathymetry/csb/tiles/{z}/{x}/{y}.pbf'
  return {
    identifier: NOAA_CSB_VECTOR_ID,
    name: 'NOAA Crowdsourced Depth Soundings',
    description:
      'Cached raw observed depths from NOAA Crowdsourced Bathymetry. Vertical datum and vessel offsets are unknown. Supplemental reference only, not for navigation.',
    type: 'S-57',
    format: 'pbf',
    chartFormat: 'pbf',
    minzoom: config.minZoom,
    maxzoom: config.maxZoom,
    bounds: expandedBounds(store.stats().bounds),
    url: tileUrl,
    tilemapUrl: tileUrl,
    layers: ['SOUNDG'],
    chartLayers: ['SOUNDG'],
    featureInfo: 'noaa-csb-sounding',
    defaultOpacity: Math.min(config.overlayOpacity, 0.65),
    defaultVisible: false
  }
}

function vectorChartResource(
  identifier: string,
  name: string,
  mode: 'datum',
  store: BathymetryStore,
  config: BathymetryConfig,
  defaultVisible: boolean
): Record<string, unknown> {
  const tileUrl = `/plugins/signalk-bathymetry/tiles/{z}/{x}/{y}.pbf?mode=${mode}`
  return {
    identifier,
    name,
    description:
      mode === 'datum'
        ? `Interactive local depth cells below ${config.targetDatum}, including quality and evidence details; not for primary navigation`
        : `Interactive tide-adjusted local depth cells with quality and evidence details; not for primary navigation`,
    type: 'S-57',
    format: 'pbf',
    chartFormat: 'pbf',
    minzoom: config.minZoom,
    maxzoom: config.maxZoom,
    bounds: expandedBounds(store.stats().bounds),
    url: tileUrl,
    tilemapUrl: tileUrl,
    layers: ['DEPARE', 'SOUNDG'],
    chartLayers: ['DEPARE', 'SOUNDG'],
    featureInfo: 'bathymetry-cell',
    style: '/plugins/signalk-bathymetry/vector-style.json',
    defaultOpacity: config.overlayOpacity,
    cellSizeControl: {
      queryParameter: 'cellScale',
      minimum: CELL_SIZE_SCALE_MIN,
      maximum: CELL_SIZE_SCALE_MAX,
      step: CELL_SIZE_SCALE_STEP,
      default: CELL_SIZE_SCALE_DEFAULT
    },
    defaultVisible
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
