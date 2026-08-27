import type { BathymetryConfig } from './types'

export function vectorStyle(config: BathymetryConfig): Record<string, unknown> {
  const safe = Math.max(0.1, config.surfaceToKeelM + config.dangerUnderKeelM)
  const blueStart = Math.max(
    safe,
    config.surfaceToKeelM * 3,
    config.surfaceToKeelM + config.dangerUnderKeelM * 2
  )
  return {
    version: 8,
    sources: {
      bathymetry: {
        type: 'vector',
        tiles: ['/plugins/signalk-bathymetry/tiles/{z}/{x}/{y}.pbf?mode=datum'],
        minzoom: config.minZoom,
        maxzoom: config.maxZoom
      }
    },
    layers: [
      {
        id: 'bathymetry-depth',
        type: 'fill',
        source: 'bathymetry',
        'source-layer': 'DEPARE',
        paint: {
          'fill-color': [
            'interpolate',
            ['linear'],
            ['to-number', ['get', 'BATHY_DEPTH_M'], -1],
            -1,
            '#872d23',
            0,
            '#d22d23',
            safe * 0.5,
            '#f57823',
            safe,
            '#f5d741',
            blueStart,
            '#d8f3ff',
            blueStart * 2,
            '#84cbf4',
            blueStart * 4,
            '#3a8fe0',
            Math.max(30, blueStart * 8),
            '#1246ab'
          ],
          'fill-opacity': 0.78
        }
      },
      {
        id: 'bathymetry-outline',
        type: 'line',
        source: 'bathymetry',
        'source-layer': 'DEPARE',
        paint: {
          'line-color': '#183846',
          'line-opacity': 0.9,
          'line-width': 1
        }
      },
      {
        id: 'bathymetry-label',
        type: 'symbol',
        source: 'bathymetry',
        'source-layer': 'SOUNDG',
        minzoom: 13,
        filter: ['==', ['get', 'BATHY_SHOW_DEPTH_LABELS'], true],
        layout: {
          'text-field': ['get', 'BATHY_LABEL'],
          'text-size': [
            '*',
            ['interpolate', ['linear'], ['zoom'], 13, 11, 20, 14],
            ['to-number', ['get', 'BATHY_LABEL_RELATIVE_SIZE'], 1]
          ],
          'text-allow-overlap': false
        },
        paint: {
          'text-color': '#101820',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5
        }
      }
    ]
  }
}
