'use strict'

const API = '/plugins/signalk-bathymetry'
const TILE_SIZE = 256
const MAX_LATITUDE = 85.05112878

const byId = (id) => document.getElementById(id)
const elements = {
  map: byId('map'),
  baseTiles: byId('base-tiles'),
  bathyTiles: byId('bathy-tiles'),
  annotations: byId('map-annotations'),
  selectedCell: byId('selected-cell'),
  boatMarker: byId('boat-marker'),
  baseChart: byId('base-chart'),
  qcLayer: byId('qc-layer'),
  depthMode: byId('depth-mode'),
  depthModeField: byId('depth-mode-field'),
  opacity: byId('overlay-opacity'),
  opacityOutput: byId('opacity-output'),
  mapMessage: byId('map-message'),
  chartStatus: byId('chart-status'),
  chartDot: byId('chart-dot'),
  mapPosition: byId('map-position'),
  zoomLevel: byId('zoom-level')
}

const state = {
  status: undefined,
  cells: [],
  charts: new Map(),
  chart: undefined,
  boat: undefined,
  center: { latitude: 0, longitude: 0 },
  hasCentered: false,
  zoom: 18,
  minimumZoom: 3,
  maximumZoom: 20,
  layer: 'depth',
  mode: 'datum',
  opacity: 0.7,
  selected: undefined,
  renderFrame: undefined,
  pointer: undefined
}

async function requestJson(url, options) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const error = new Error(body.error || `${response.status} ${response.statusText}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

function project(position, zoom = state.zoom) {
  const latitude = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, position.latitude))
  const scale = TILE_SIZE * 2 ** zoom
  const sin = Math.sin((latitude * Math.PI) / 180)
  return {
    x: ((position.longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
  }
}

function unproject(point, zoom = state.zoom) {
  const scale = TILE_SIZE * 2 ** zoom
  const longitude = (point.x / scale) * 360 - 180
  const n = Math.PI - (2 * Math.PI * point.y) / scale
  return {
    latitude: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    longitude: normalizeLongitude(longitude)
  }
}

function normalizeLongitude(longitude) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180
}

function wrappedDeltaX(x, centerX, worldSize) {
  let delta = x - centerX
  if (delta > worldSize / 2) delta -= worldSize
  if (delta < -worldSize / 2) delta += worldSize
  return delta
}

function scheduleMapRender() {
  if (state.renderFrame !== undefined) return
  state.renderFrame = requestAnimationFrame(() => {
    state.renderFrame = undefined
    renderMap()
  })
}

function renderMap() {
  const width = elements.map.clientWidth
  const height = elements.map.clientHeight
  if (!width || !height) return
  elements.baseTiles.replaceChildren()
  elements.bathyTiles.replaceChildren()

  if (state.chart) {
    const sourceZoom = Math.max(
      Number(state.chart.minzoom ?? state.chart.minZoom ?? 0),
      Math.min(Number(state.chart.maxzoom ?? state.chart.maxZoom ?? state.zoom), state.zoom)
    )
    addTileLayer(elements.baseTiles, chartTileTemplate(state.chart), sourceZoom, state.zoom)
  }

  if (state.zoom >= Number(state.status?.config?.minZoom ?? 8)) {
    const unitRevision = state.status?.depthDisplayUnits?.revision
    const query = new URLSearchParams({ layer: state.layer, mode: state.mode })
    if (unitRevision) query.set('units', unitRevision)
    addTileLayer(
      elements.bathyTiles,
      `${API}/tiles/{z}/{x}/{y}.png?${query.toString()}`,
      state.zoom,
      state.zoom
    )
  }

  elements.bathyTiles.style.opacity = String(state.opacity)
  elements.zoomLevel.textContent = String(state.zoom)
  elements.mapPosition.textContent = `${state.center.latitude.toFixed(5)}, ${state.center.longitude.toFixed(5)}`
  renderBoatMarker(width, height)
  renderSelectedCell(width, height)
}

function addTileLayer(pane, template, sourceZoom, displayZoom) {
  if (!template || !template.includes('{z}') || !template.includes('{x}')) return
  const width = elements.map.clientWidth
  const height = elements.map.clientHeight
  const center = project(state.center, displayZoom)
  const scale = 2 ** (displayZoom - sourceZoom)
  const displayTileSize = TILE_SIZE * scale
  const count = 2 ** sourceZoom
  const startX = Math.floor((center.x - width / 2) / displayTileSize) - 1
  const endX = Math.floor((center.x + width / 2) / displayTileSize) + 1
  const startY = Math.max(0, Math.floor((center.y - height / 2) / displayTileSize) - 1)
  const endY = Math.min(count - 1, Math.floor((center.y + height / 2) / displayTileSize) + 1)

  for (let sourceY = startY; sourceY <= endY; sourceY += 1) {
    for (let displayX = startX; displayX <= endX; displayX += 1) {
      const sourceX = ((displayX % count) + count) % count
      const image = document.createElement('img')
      image.alt = ''
      image.decoding = 'async'
      image.draggable = false
      image.src = tileUrl(template, sourceZoom, sourceX, sourceY, count)
      image.style.width = `${displayTileSize}px`
      image.style.height = `${displayTileSize}px`
      image.style.left = `${displayX * displayTileSize - center.x + width / 2}px`
      image.style.top = `${sourceY * displayTileSize - center.y + height / 2}px`
      pane.append(image)
    }
  }
}

function tileUrl(template, zoom, x, y, count) {
  const url = template
    .replaceAll('{z}', String(zoom))
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y))
    .replaceAll('{-y}', String(count - y - 1))
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}qcRefresh=${Math.floor(Date.now() / 600_000)}`
}

function chartTileTemplate(chart) {
  return String(chart.url || chart.tilemapUrl || '')
}

function mapPoint(position, width = elements.map.clientWidth, height = elements.map.clientHeight) {
  const worldSize = TILE_SIZE * 2 ** state.zoom
  const center = project(state.center)
  const point = project(position)
  return {
    x: width / 2 + wrappedDeltaX(point.x, center.x, worldSize),
    y: height / 2 + point.y - center.y
  }
}

function renderBoatMarker(width, height) {
  if (!state.boat) {
    elements.boatMarker.hidden = true
    return
  }
  const point = mapPoint(state.boat, width, height)
  elements.boatMarker.hidden = false
  elements.boatMarker.style.left = `${point.x}px`
  elements.boatMarker.style.top = `${point.y}px`
}

function renderSelectedCell(width, height) {
  const coordinates = state.selected?.geometry?.coordinates?.[0]
  if (!Array.isArray(coordinates)) {
    elements.selectedCell.setAttribute('points', '')
    return
  }
  const points = coordinates
    .map(([longitude, latitude]) => mapPoint({ latitude, longitude }, width, height))
    .map((point) => `${point.x},${point.y}`)
    .join(' ')
  elements.selectedCell.setAttribute('points', points)
}

function zoomAt(delta, clientX, clientY) {
  const nextZoom = Math.max(state.minimumZoom, Math.min(state.maximumZoom, state.zoom + delta))
  if (nextZoom === state.zoom) return
  const rect = elements.map.getBoundingClientRect()
  const offsetX = clientX - rect.left - rect.width / 2
  const offsetY = clientY - rect.top - rect.height / 2
  const oldCenter = project(state.center)
  const anchor = unproject({ x: oldCenter.x + offsetX, y: oldCenter.y + offsetY })
  const nextAnchor = project(anchor, nextZoom)
  state.zoom = nextZoom
  state.center = unproject({ x: nextAnchor.x - offsetX, y: nextAnchor.y - offsetY }, nextZoom)
  scheduleMapRender()
}

function panByPixels(horizontal, vertical) {
  const center = project(state.center)
  state.center = unproject({ x: center.x + horizontal, y: center.y + vertical })
  scheduleMapRender()
}

function centerOnBoat() {
  if (!state.boat) return
  state.center = { ...state.boat }
  state.hasCentered = true
  scheduleMapRender()
}

function configureMapInteractions() {
  elements.map.addEventListener('wheel', (event) => {
    event.preventDefault()
    zoomAt(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY)
  }, { passive: false })

  elements.map.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, a, select, input')) return
    elements.map.setPointerCapture(event.pointerId)
    state.pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      center: project(state.center),
      moved: false
    }
  })

  elements.map.addEventListener('pointermove', (event) => {
    if (!state.pointer || state.pointer.id !== event.pointerId) return
    const deltaX = event.clientX - state.pointer.startX
    const deltaY = event.clientY - state.pointer.startY
    if (Math.hypot(deltaX, deltaY) > 5) state.pointer.moved = true
    state.center = unproject({
      x: state.pointer.center.x - deltaX,
      y: state.pointer.center.y - deltaY
    })
    scheduleMapRender()
  })

  elements.map.addEventListener('pointerup', (event) => {
    if (!state.pointer || state.pointer.id !== event.pointerId) return
    const moved = state.pointer.moved
    state.pointer = undefined
    if (!moved) inspectMapPoint(event.clientX, event.clientY)
  })

  elements.map.addEventListener('pointercancel', () => { state.pointer = undefined })
  elements.map.addEventListener('keydown', (event) => {
    const movements = {
      ArrowLeft: [-80, 0],
      ArrowRight: [80, 0],
      ArrowUp: [0, -80],
      ArrowDown: [0, 80]
    }
    if (movements[event.key]) {
      event.preventDefault()
      panByPixels(...movements[event.key])
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      const rect = elements.map.getBoundingClientRect()
      zoomAt(1, rect.left + rect.width / 2, rect.top + rect.height / 2)
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      const rect = elements.map.getBoundingClientRect()
      zoomAt(-1, rect.left + rect.width / 2, rect.top + rect.height / 2)
    } else if (event.key.toLowerCase() === 'c') {
      centerOnBoat()
    }
  })

  byId('zoom-in').addEventListener('click', () => {
    const rect = elements.map.getBoundingClientRect()
    zoomAt(1, rect.left + rect.width / 2, rect.top + rect.height / 2)
  })
  byId('zoom-out').addEventListener('click', () => {
    const rect = elements.map.getBoundingClientRect()
    zoomAt(-1, rect.left + rect.width / 2, rect.top + rect.height / 2)
  })
  byId('center-boat').addEventListener('click', centerOnBoat)
  window.addEventListener('resize', scheduleMapRender)
}

async function inspectMapPoint(clientX, clientY) {
  const rect = elements.map.getBoundingClientRect()
  const center = project(state.center)
  const position = unproject({
    x: center.x + clientX - rect.left - rect.width / 2,
    y: center.y + clientY - rect.top - rect.height / 2
  })
  elements.mapMessage.textContent = 'Looking up cell evidence…'
  try {
    const query = new URLSearchParams({
      latitude: String(position.latitude),
      longitude: String(position.longitude)
    })
    const cell = await requestJson(`${API}/cells/lookup?${query}`)
    state.selected = cell
    renderInspection(cell)
    scheduleMapRender()
    elements.mapMessage.textContent = ''
    await loadCellEvidence(cell)
  } catch (error) {
    elements.mapMessage.textContent = error.status === 404
      ? 'No measured bathymetry cell at that position.'
      : `Unable to inspect this position: ${error.message}`
    setTimeout(() => {
      if (elements.mapMessage.textContent.startsWith('No measured') || elements.mapMessage.textContent.startsWith('Unable')) {
        elements.mapMessage.textContent = ''
      }
    }, 2800)
  }
}

function renderInspection(cell) {
  byId('inspection-empty').hidden = true
  byId('inspection-detail').hidden = false
  byId('cell-depth').textContent = `${formatDepth(cell.renderDepthM)} ${depthSymbol()} ${cell.datum}`
  const center = polygonCenter(cell.geometry?.coordinates?.[0])
  byId('cell-coordinate').textContent = center
    ? `${center.latitude.toFixed(6)}, ${center.longitude.toFixed(6)}`
    : `Cell ${cell.cellX}, ${cell.cellY}`
  byId('cell-confidence').textContent = `${Math.round(cell.confidence * 100)}%`
  byId('cell-age').textContent = formatAge(cell.newestAtMs)
  byId('cell-sigma').textContent = `±${formatDepth(cell.verticalSigmaM)} ${depthSymbol()} (1σ)`
  byId('cell-conservative').textContent = `${formatDepth(cell.conservativeDepthM)} ${depthSymbol()}`
  byId('cell-samples').textContent = number(cell.soundingCount)
  byId('cell-observations').textContent = number(cell.observationCount)
  byId('cell-passes').textContent = number(cell.passCount)
  byId('cell-sources').textContent = number(cell.sourceCount)
  byId('cell-range').textContent = `${formatDate(cell.oldestAtMs)} – ${formatDate(cell.newestAtMs)}`

  const stateBadge = byId('cell-state')
  stateBadge.textContent = friendlyChangeState(cell.changeState)
  stateBadge.className = `state-badge ${cell.changeState === 'stable' ? '' : cell.changeState === 'confirmed' ? 'danger' : 'warning'}`
  renderCellFlags(cell)
  byId('evidence-summary').textContent = 'Loading raw observations…'
  byId('evidence-list').replaceChildren()
}

function renderCellFlags(cell) {
  const flags = []
  if (cell.confidence < 0.55) flags.push(['Low confidence', 'danger'])
  else if (cell.confidence < 0.75) flags.push(['Moderate confidence', 'warning'])
  else flags.push(['Strong confidence', 'good'])
  if (cell.passCount <= 1) flags.push(['Single pass', 'warning'])
  else flags.push([`${cell.passCount} passes`, 'good'])
  if (cell.sourceCount <= 1) flags.push(['Single source', 'warning'])
  else flags.push([`${cell.sourceCount} sources`, 'good'])
  if (ageDays(cell.newestAtMs) > recencyHalfLifeDays()) flags.push(['Older than confidence half-life', 'danger'])
  if (cell.changeState !== 'stable') flags.push([friendlyChangeState(cell.changeState), 'danger'])
  const container = byId('cell-flags')
  container.replaceChildren(...flags.map(([label, tone]) => {
    const flag = document.createElement('span')
    flag.className = `flag ${tone}`
    flag.textContent = label
    return flag
  }))
}

async function loadCellEvidence(cell) {
  const bounds = cell.bounds
  if (!Array.isArray(bounds) || bounds.length !== 4) return
  try {
    const query = new URLSearchParams({ bbox: bounds.join(','), limit: '1000' })
    const response = await requestJson(`${API}/soundings?${query}`)
    const polygon = cell.geometry?.coordinates?.[0]
    const soundings = (response.soundings || []).filter((sounding) =>
      Array.isArray(polygon) ? pointInPolygon(sounding.position, polygon) : true
    )
    const accepted = soundings.filter((item) => item.qcState === 'accepted').length
    const quarantined = soundings.filter((item) => item.qcState === 'quarantined').length
    const sourceSamples = soundings.reduce((sum, item) => sum + Number(item.sampleCount || 1), 0)
    byId('evidence-summary').textContent = `${soundings.length} records · ${sourceSamples.toLocaleString()} source samples · ${accepted} accepted · ${quarantined} quarantined`
    const rows = soundings.slice(0, 30).map(evidenceRow)
    if (soundings.length > 30) {
      const remainder = document.createElement('p')
      remainder.className = 'coordinate'
      remainder.textContent = `${soundings.length - 30} older records not shown.`
      rows.push(remainder)
    }
    byId('evidence-list').replaceChildren(...rows)
  } catch (error) {
    byId('evidence-summary').textContent = `Evidence unavailable: ${error.message}`
  }
}

function evidenceRow(item) {
  const row = document.createElement('article')
  row.className = 'evidence-row'
  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = new Date(item.observedAt).toLocaleString()
  const depth = document.createElement('span')
  depth.className = 'depth'
  depth.textContent = `${formatDepth(item.datumDepthM)} ${depthSymbol()}`
  const meta = document.createElement('span')
  meta.className = 'meta'
  const parts = [item.origin, item.depthSource, item.aggregationKind]
  if (item.sampleCount > 1) parts.push(`${item.sampleCount} pings`)
  if (item.rejectedSampleCount > 0) parts.push(`${item.rejectedSampleCount} spikes excluded`)
  if (item.qcReasons?.length) parts.push(item.qcReasons.join(', '))
  meta.textContent = parts.join(' · ')
  const qc = document.createElement('span')
  qc.className = `qc-pill ${item.qcState}`
  qc.textContent = item.qcState
  row.append(time, depth, meta, qc)
  return row
}

function pointInPolygon(position, polygon) {
  if (!position || !Array.isArray(polygon)) return false
  const x = position.longitude
  const y = position.latitude
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [xi, yi] = polygon[index]
    const [xj, yj] = polygon[previous]
    const crosses = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

function polygonCenter(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return undefined
  const points = polygon.slice(0, -1)
  if (points.length === 0) return undefined
  return {
    longitude: points.reduce((sum, point) => sum + point[0], 0) / points.length,
    latitude: points.reduce((sum, point) => sum + point[1], 0) / points.length
  }
}

async function refreshStatus() {
  try {
    const status = await requestJson(`${API}/status`)
    state.status = status
    state.maximumZoom = Number(status.config.maxZoom ?? 20)
    renderStatus(status)
    if (state.cells.length === 0 && status.store.bounds) await refreshCells(status.store.bounds)
    scheduleMapRender()
  } catch (error) {
    const liveState = document.querySelector('.live-state')
    liveState.classList.add('offline')
    byId('capture-state').textContent = `Unavailable: ${error.message}`
  }
}

function renderStatus(data) {
  document.querySelector('.live-state').classList.toggle('offline', !data.capture.running)
  byId('capture-state').textContent = data.capture.running ? 'Recording' : 'Capture stopped'
  byId('source-samples').textContent = number(data.store.sourceSamples)
  byId('source-note').textContent = `${number(data.store.rejectedStationarySamples)} stationary spikes excluded`
  byId('stored-records').textContent = number(data.store.soundings)
  byId('accepted-note').textContent = `${number(data.store.accepted)} accepted · ${number(data.store.quarantined)} quarantined`
  byId('cell-count').textContent = number(data.store.cells)
  byId('latest-age').textContent = data.store.latestObservationMs ? formatAge(data.store.latestObservationMs) : 'No data'
  byId('latest-at').textContent = data.store.latestObservationMs ? formatDateTime(data.store.latestObservationMs) : 'Awaiting observations'
  byId('stationary-rejected').textContent = number(data.store.rejectedStationarySamples)
  byId('tide').textContent = data.capture.latestTide
    ? `${formatDepth(data.capture.latestTide.heightM)} ${depthSymbol()} · ${data.capture.latestTide.stationName} · ${data.capture.latestTide.method}${data.capture.latestTide.stale ? ' · stale' : ''}`
    : 'Unavailable'
  byId('auto-backfill').textContent = `${data.autoBackfill.state.replaceAll('_', ' ')} · ${data.autoBackfill.lookbackDays} day lookback${data.autoBackfill.importedRecords !== undefined ? ` · ${number(data.autoBackfill.importedRecords)} records imported` : ''}`
  byId('error').textContent = data.capture.lastError || 'None'
}

async function refreshCells(bounds) {
  const bbox = safeBbox(bounds)
  const response = await requestJson(`${API}/cells?bbox=${bbox.join(',')}`)
  state.cells = response.cells || []
  renderAudit()
}

function safeBbox(bounds) {
  let [west, south, east, north] = bounds.map(Number)
  if (west === east) { west -= .001; east += .001 }
  if (south === north) { south -= .001; north += .001 }
  return [west, south, east, north]
}

function renderAudit() {
  const cells = state.cells
  const lowConfidence = cells.filter((cell) => cell.confidence < .55).length
  const singlePass = cells.filter((cell) => cell.passCount <= 1).length
  const singleSource = cells.filter((cell) => cell.sourceCount <= 1).length
  const old = cells.filter((cell) => ageDays(cell.newestAtMs) > recencyHalfLifeDays()).length
  const changes = cells.filter((cell) => cell.changeState !== 'stable').length
  const cards = [
    [lowConfidence, 'Low-confidence cells', lowConfidence ? 'danger' : ''],
    [singlePass, 'Cells supported by one pass', singlePass ? 'warning' : ''],
    [singleSource, 'Cells supported by one source', singleSource ? 'warning' : ''],
    [old, `Cells older than ${number(recencyHalfLifeDays())} days`, old ? 'warning' : ''],
    [changes, 'Change candidates requiring review', changes ? 'danger' : '']
  ]
  byId('audit-cards').replaceChildren(...cards.map(([value, label, tone]) => {
    const card = document.createElement('article')
    if (tone) card.className = tone
    const strong = document.createElement('strong')
    strong.textContent = number(value)
    const span = document.createElement('span')
    span.textContent = label
    card.append(strong, span)
    return card
  }))
  byId('cell-note').textContent = `${number(changes)} change candidates · ${number(lowConfidence)} low confidence`
  byId('audit-updated').textContent = `Calculated ${new Date().toLocaleTimeString()}`
}

async function refreshBoatPosition() {
  try {
    const position = await requestJson('/signalk/v1/api/vessels/self/navigation/position/value')
    if (!Number.isFinite(position.latitude) || !Number.isFinite(position.longitude)) throw new Error('Invalid vessel position')
    state.boat = { latitude: position.latitude, longitude: position.longitude }
    if (!state.hasCentered) centerOnBoat()
    else scheduleMapRender()
  } catch (error) {
    if (!state.hasCentered && state.status?.store?.bounds) {
      const [west, south, east, north] = state.status.store.bounds
      state.center = { latitude: (south + north) / 2, longitude: (west + east) / 2 }
      state.hasCentered = true
      scheduleMapRender()
    }
  }
}

async function discoverCharts() {
  elements.baseChart.disabled = true
  try {
    const resources = await requestJson('/signalk/v2/api/resources/charts')
    const charts = Object.entries(resources)
      .map(([identifier, resource]) => ({ identifier, ...resource }))
      .filter((chart) => !String(chart.identifier).startsWith('signalk-bathymetry-'))
      .filter((chart) => chartTileTemplate(chart).includes('{z}') && chartTileTemplate(chart).includes('{x}'))
    state.charts = new Map(charts.map((chart) => [chart.identifier, chart]))
    populateChartSelect(charts)
    const preferred = String(state.status?.config?.qcBaseChart || 'noaa-enc').trim()
    state.chart = selectPreferredChart(charts, preferred)
    if (state.chart) {
      elements.baseChart.value = state.chart.identifier
      const local = chartTileTemplate(state.chart).startsWith('/')
      elements.chartStatus.textContent = `${state.chart.name || state.chart.identifier}${local ? ' · served through Signal K' : ' · remote tiles'}`
      elements.chartDot.className = 'status-dot'
      elements.mapMessage.textContent = ''
    } else {
      elements.chartStatus.textContent = 'No compatible chart resource found'
      elements.chartDot.className = 'status-dot warning'
      elements.mapMessage.textContent = 'Bathymetry is available, but no backing chart was found. Install and configure the optional Signal K Charts plugin.'
    }
    elements.baseChart.disabled = charts.length === 0
    scheduleMapRender()
  } catch (error) {
    elements.baseChart.replaceChildren(new Option('No Signal K charts available', ''))
    elements.chartStatus.textContent = `Chart catalog unavailable: ${error.message}`
    elements.chartDot.className = 'status-dot error'
    elements.mapMessage.textContent = 'Bathymetry is available, but the optional Signal K chart provider is not.'
  }
}

function populateChartSelect(charts) {
  const options = charts
    .sort((a, b) => String(a.name || a.identifier).localeCompare(String(b.name || b.identifier)))
    .map((chart) => new Option(chart.name || chart.identifier, chart.identifier))
  elements.baseChart.replaceChildren(...options)
}

function selectPreferredChart(charts, preferred) {
  const normalized = preferred.toLowerCase()
  const exact = charts.find((chart) =>
    chart.identifier.toLowerCase() === normalized || String(chart.name || '').toLowerCase() === normalized
  )
  if (exact) return exact
  const contains = charts.find((chart) =>
    chart.identifier.toLowerCase().includes(normalized) || String(chart.name || '').toLowerCase().includes(normalized)
  )
  if (contains) return contains
  return charts.find((chart) => /noaa.*(enc|chart)|(enc|chart).*noaa/i.test(`${chart.identifier} ${chart.name || ''}`)) || charts[0]
}

function configureControls() {
  elements.baseChart.addEventListener('change', () => {
    state.chart = state.charts.get(elements.baseChart.value)
    if (state.chart) {
      elements.chartStatus.textContent = `${state.chart.name || state.chart.identifier} · served through Signal K`
      elements.chartDot.className = 'status-dot'
    }
    scheduleMapRender()
  })
  elements.qcLayer.addEventListener('change', () => {
    state.layer = elements.qcLayer.value
    elements.depthModeField.hidden = state.layer !== 'depth'
    updateLegend()
    scheduleMapRender()
  })
  elements.depthMode.addEventListener('change', () => {
    state.mode = elements.depthMode.value
    scheduleMapRender()
  })
  elements.opacity.addEventListener('input', () => {
    state.opacity = Number(elements.opacity.value)
    elements.opacityOutput.textContent = `${Math.round(state.opacity * 100)}%`
    elements.bathyTiles.style.opacity = String(state.opacity)
  })
}

function updateLegend() {
  const legend = {
    depth: {
      low: 'Danger / dry', high: 'Deeper',
      gradient: 'linear-gradient(90deg,#d22d23,#f57823,#f5d741,#32cdd7,#2378cd,#192d6e)',
      note: 'Gray hatching marks confidence below 55%; magenta outlines mark possible seabed change.'
    },
    confidence: {
      low: 'Low confidence', high: 'High confidence',
      gradient: 'linear-gradient(90deg,#b52b32,#e38b32,#ead85f,#58c798,#1c8d73)',
      note: 'Confidence includes uncertainty, repeatability, visit and source diversity, and recency.'
    },
    age: {
      low: 'Old evidence', high: 'Fresh evidence',
      gradient: 'linear-gradient(90deg,#7e3c37,#b9783e,#d7c46a,#6fc1a4,#238d78)',
      note: `Confidence decays with a configured ${number(recencyHalfLifeDays())}-day half-life.`
    },
    change: {
      low: 'Stable', high: 'Confirmed / review',
      gradient: 'linear-gradient(90deg,#287761,#6e9f6c,#e5bb52,#e67754,#cb3f70)',
      note: 'Shoaling is rendered conservatively at once; apparent deepening requires repeated independent passes.'
    }
  }[state.layer]
  byId('legend-low').textContent = legend.low
  byId('legend-high').textContent = legend.high
  byId('legend-gradient').style.background = legend.gradient
  byId('legend-note').textContent = legend.note
}

function depthSymbol() {
  return state.status?.depthDisplayUnits?.symbol || 'm'
}

function formatDepth(meters) {
  const factor = Number(state.status?.depthDisplayUnits?.metersToDisplayFactor || 1)
  const value = Number(meters) * factor
  const decimals = Math.abs(value) >= 10 ? 0 : 1
  return value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function recencyHalfLifeDays() {
  return Number(state.status?.config?.recencyHalfLifeDays || 365)
}

function ageDays(timestamp) {
  return Math.max(0, Date.now() - Number(timestamp)) / 86_400_000
}

function formatAge(timestamp) {
  const elapsed = Math.max(0, Date.now() - Number(timestamp))
  const minutes = elapsed / 60_000
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${Math.floor(minutes)}m ago`
  const hours = minutes / 60
  if (hours < 48) return `${Math.floor(hours)}h ago`
  const days = hours / 24
  if (days < 730) return `${Math.floor(days)}d ago`
  return `${(days / 365.25).toFixed(1)}y ago`
}

function formatDate(timestamp) {
  return new Date(Number(timestamp)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDateTime(timestamp) {
  return new Date(Number(timestamp)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function friendlyChangeState(value) {
  return {
    stable: 'Stable',
    suspected_shoaling: 'Suspected shoaling',
    candidate_deepening: 'Candidate deepening',
    confirmed: 'Confirmed change'
  }[value] || String(value).replaceAll('_', ' ')
}

function number(value) {
  return Number(value || 0).toLocaleString()
}

async function start() {
  configureControls()
  configureMapInteractions()
  await refreshStatus()
  await Promise.all([refreshBoatPosition(), discoverCharts()])
  updateLegend()
  scheduleMapRender()
  setInterval(refreshStatus, 10_000)
  setInterval(refreshBoatPosition, 10_000)
  setInterval(() => {
    if (state.status?.store?.bounds) refreshCells(state.status.store.bounds).catch(() => {})
  }, 60_000)
  setInterval(scheduleMapRender, 600_000)
}

start().catch((error) => {
  elements.mapMessage.textContent = `Unable to start the quality-control page: ${error.message}`
})
