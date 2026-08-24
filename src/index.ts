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
        const store = new BathymetryStore(join(app.getDataDirPath(), 'bathymetry.sqlite'), config)
        const capture = new CaptureEngine(app, store, config)
        const history = new HistoryBackfill(app, capture, config)
        const autoBackfill = new AutoBackfill(app, store, history, config)
        const renderer = new TileRenderer(store, config, (atMs) =>
          capture.latestTideProjection(atMs)
        )
        runtime = { config, store, capture, history, autoBackfill, renderer }
        app.registerResourceProvider(createChartProvider(store, config))
        capture.start()
        autoBackfill.start()
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
  runtime.autoBackfill.stop()
  runtime.capture.stop()
  runtime.store.close()
}

export = constructor
