import { join } from 'node:path'
import type { Plugin, PluginConstructor, ServerAPI } from '@signalk/server-api'
import { openApi, registerRoutes, type Runtime } from './api'
import { AutoBackfill } from './auto-backfill'
import { CaptureEngine } from './capture'
import { createChartProvider } from './charts'
import { normalizeConfig, pluginSchema } from './config'
import { HistoryBackfill } from './history-backfill'
import { BathymetryStore } from './store'
import { DepthUnitPreferences } from './depth-units'
import { VectorTileRenderer } from './vector-tiles'
import { NoaaCsbImporter, NoaaCsbStore } from './noaa-csb'
import { NoaaCsbTileRenderer } from './noaa-csb-tiles'

const constructor: PluginConstructor = (app: ServerAPI): Plugin => {
  let runtime: Runtime | undefined

  return {
    id: 'signalk-bathymetry',
    name: 'Local Bathymetry',
    description:
      'Builds a datum-reduced local bathymetry surface with confidence, change detection, and interactive vector cells.',
    schema: pluginSchema,
    start: (rawConfig) => {
      if (runtime) stopRuntime(runtime)
      try {
        const config = normalizeConfig(rawConfig)
        const dataDirectory = app.getDataDirPath()
        const store = new BathymetryStore(join(dataDirectory, 'bathymetry.sqlite'), config)
        const csbStore = new NoaaCsbStore(join(dataDirectory, 'noaa-csb.sqlite'))
        const csbImporter = new NoaaCsbImporter(csbStore)
        const capture = new CaptureEngine(app, store, config)
        const history = new HistoryBackfill(app, capture, config)
        const autoBackfill = new AutoBackfill(app, store, history, config)
        const depthUnits = new DepthUnitPreferences(
          app,
          join(dataDirectory, 'depth-display-units.json')
        )
        const vectorRenderer = new VectorTileRenderer(
          store,
          config,
          (atMs) => capture.latestTideProjection(atMs),
          () => depthUnits.current()
        )
        const csbRenderer = new NoaaCsbTileRenderer(csbStore, config.minZoom, config.maxZoom)
        runtime = {
          config,
          store,
          capture,
          history,
          autoBackfill,
          depthUnits,
          vectorRenderer,
          csbStore,
          csbImporter,
          csbRenderer
        }
        app.registerResourceProvider(createChartProvider(store, config, csbStore))
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
  runtime.csbImporter.stop()
  runtime.depthUnits.stop()
  runtime.autoBackfill.stop()
  runtime.capture.stop()
  runtime.store.close()
  runtime.csbStore.close()
}

export = constructor
