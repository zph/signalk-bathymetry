import { join } from 'node:path'
import type { Plugin, PluginConstructor, ServerAPI } from '@signalk/server-api'
import { openApi, registerRoutes, type Runtime } from './api'
import { AutoBackfill } from './auto-backfill'
import { CaptureEngine } from './capture'
import { createChartProvider } from './charts'
import { normalizeConfig, pluginSchema } from './config'
import { HistoryBackfill } from './history-backfill'
import { BathymetryStore } from './store'
import { TileRenderer } from './tiles'
import { DepthUnitPreferences } from './depth-units'
import { createInfoLayerProvider } from './info-layers'

const constructor: PluginConstructor = (app: ServerAPI): Plugin => {
  let runtime: Runtime | undefined

  return {
    id: 'signalk-bathymetry',
    name: 'Local Bathymetry',
    description:
      'Builds a datum-reduced local bathymetry surface with confidence, change detection, and Freeboard overlays.',
    schema: pluginSchema,
    start: (rawConfig) => {
      if (runtime) stopRuntime(runtime)
      try {
        const config = normalizeConfig(rawConfig)
        const dataDirectory = app.getDataDirPath()
        const store = new BathymetryStore(join(dataDirectory, 'bathymetry.sqlite'), config)
        const capture = new CaptureEngine(app, store, config)
        const history = new HistoryBackfill(app, capture, config)
        const autoBackfill = new AutoBackfill(app, store, history, config)
        const depthUnits = new DepthUnitPreferences(
          app,
          join(dataDirectory, 'depth-display-units.json')
        )
        const renderer = new TileRenderer(
          store,
          config,
          (atMs) => capture.latestTideProjection(atMs),
          () => depthUnits.current()
        )
        runtime = { config, store, capture, history, autoBackfill, depthUnits, renderer }
        app.registerResourceProvider(createChartProvider(store, config, () => depthUnits.current()))
        app.registerResourceProvider(createInfoLayerProvider(config, () => depthUnits.current()))
        capture.start()
        autoBackfill.start()
        depthUnits.start()
        const stats = store.stats()
        app.setPluginStatus(
          `Recording local bathymetry; ${stats.sourceSamples} source samples in ${stats.soundings} records, ${stats.cells} cells, ${config.targetDatum}`
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        app.error(`Unable to start bathymetry: ${message}`)
        app.setPluginError(message)
        throw error
      }
    },
    stop: () => {
      if (!runtime) return
      stopRuntime(runtime)
      runtime = undefined
    },
    registerWithRouter: (router) => registerRoutes(router, () => runtime),
    getOpenApi: openApi,
    statusMessage: () => {
      if (!runtime) return 'Stopped'
      const stats = runtime.store.stats()
      return `${stats.sourceSamples} samples; ${stats.cells} cells; ${runtime.config.targetDatum}`
    }
  }
}

function stopRuntime(runtime: Runtime): void {
  runtime.depthUnits.stop()
  runtime.autoBackfill.stop()
  runtime.capture.stop()
  runtime.store.close()
}

export = constructor
