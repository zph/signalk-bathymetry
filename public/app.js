'use strict'

const byId = (id) => document.getElementById(id)

async function refresh() {
  try {
    const response = await fetch('/plugins/signalk-bathymetry/status', { cache: 'no-store' })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const data = await response.json()
    byId('soundings').textContent = Number(data.store.sourceSamples).toLocaleString()
    byId('cells').textContent = Number(data.store.cells).toLocaleString()
    byId('accepted').textContent = Number(data.store.soundings).toLocaleString()
    byId('datum').textContent = data.config.targetDatum
    byId('danger-threshold').textContent = `Danger at ≤ ${Number(data.config.dangerUnderKeelM).toFixed(2)} m under keel`
    byId('capture-state').textContent = data.capture.running ? 'Recording' : 'Stopped'
    byId('last-sample').textContent = data.capture.lastCaptureMs
      ? new Date(data.capture.lastCaptureMs).toLocaleString()
      : 'No live sample yet'
    byId('tide').textContent = data.capture.latestTide
      ? `${data.capture.latestTide.heightM.toFixed(2)} m · ${data.capture.latestTide.stationName}${data.capture.latestTide.stale ? ' · stale' : ''}`
      : 'Unavailable'
    byId('error').textContent = data.capture.lastError || 'None'
  } catch (error) {
    byId('capture-state').textContent = `Unavailable: ${error.message}`
  }
}

refresh()
setInterval(refresh, 10_000)
