'use strict'
const $ = (id) => document.getElementById(id)
const colors = ['#6fe0cc', '#ffc66d', '#bfa8ff', '#ff92a2', '#93d6ff', '#d8e77c']
const state = {
  journeys: [],
  tracks: new Map(),
  selected: '',
  page: 0,
  center: [0, 0],
  zoom: 1,
  point: null,
  generation: 0
}
const canvas = $('map'),
  ctx = canvas.getContext('2d')
const key = (j) => JSON.stringify([j.vesselId, j.journeyId])
const merc = (p) => [
  p.longitude / 360,
  -Math.asinh(Math.tan((Math.max(-85, Math.min(85, p.latitude)) * Math.PI) / 180)) / (2 * Math.PI)
]
const date = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
async function get(path) {
  const r = await fetch('/plugins/signalk-bathymetry/csb/' + path, {
    credentials: 'same-origin'
  })
  if (!r.ok)
    throw Error(
      r.status === 401
        ? 'Sign in to Signal K, then refresh this page.'
        : `Request failed (${r.status})`
    )
  return r.json()
}
function matches(j) {
  return (
    ['vessel', 'provider', 'instrument'].every(
      (f) => !$(f).value || String(j[f === 'vessel' ? 'vesselId' : f]) === $(f).value
    ) &&
    (!$('from').value || j.endAtMs >= Date.parse($('from').value)) &&
    (!$('through').value || j.startAtMs < Date.parse($('through').value) + 86400000)
  )
}
function visible() {
  return state.journeys.filter(matches)
}
function shown() {
  return visible().filter((j) => !state.selected || key(j) === state.selected)
}
function color(j) {
  return colors[
    [...new Set(state.journeys.map((j) => j.vesselId))].indexOf(j.vesselId) % colors.length
  ]
}
function screen(p) {
  const v = merc(p)
  return [
    (v[0] - state.center[0]) * state.zoom + canvas.clientWidth / 2,
    (v[1] - state.center[1]) * state.zoom + canvas.clientHeight / 2
  ]
}
function fit() {
  const js = shown()
  if (!js.length) return
  const a = merc({
      longitude: Math.min(...js.map((j) => j.west)),
      latitude: Math.max(...js.map((j) => j.north))
    }),
    b = merc({
      longitude: Math.max(...js.map((j) => j.east)),
      latitude: Math.min(...js.map((j) => j.south))
    })
  state.center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  state.zoom = Math.min(
    (canvas.clientWidth - 60) / Math.max(b[0] - a[0], 1e-6),
    (canvas.clientHeight - 60) / Math.max(b[1] - a[1], 1e-6)
  )
  draw()
}
function disconnected(a, b) {
  return (
    b.observedAtMs - a.observedAtMs > 300000 ||
    Math.abs(a.longitude - b.longitude) > 180 ||
    Math.hypot(
      (a.longitude - b.longitude) * Math.cos((a.latitude * Math.PI) / 180),
      a.latitude - b.latitude
    ) *
      111320 >
      Math.max(100, (Math.abs(b.observedAtMs - a.observedAtMs) / 1000) * 30)
  )
}
function draw() {
  const w = canvas.clientWidth,
    h = canvas.clientHeight,
    dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.strokeStyle = '#264451'
  ctx.font = '11px system-ui'
  ctx.fillStyle = '#91aebb'
  ctx.lineWidth = 1
  for (let x = 0; x < w; x += 80) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
    const lon = (state.center[0] + (x - w / 2) / state.zoom) * 360
    ctx.fillText(`${lon.toFixed(2)}°`, x + 3, 14)
  }
  for (let y = 0; y < h; y += 80) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    const lat =
      (Math.atan(Math.sinh(-(state.center[1] + (y - h / 2) / state.zoom) * 2 * Math.PI)) * 180) /
      Math.PI
    ctx.fillText(`${lat.toFixed(2)}°`, 3, y + 26)
  }
  for (const j of shown()) {
    const ps = state.tracks.get(key(j)) || []
    ctx.strokeStyle = color(j)
    ctx.fillStyle = color(j)
    ctx.lineWidth = 2
    ctx.beginPath()
    let last = null,
      painted = null
    for (const p of ps) {
      const s = screen(p)
      if (!last || disconnected(last, p)) {
        ctx.moveTo(...s)
        ctx.fillRect(s[0] - 2, s[1] - 2, 4, 4)
        painted = s
      } else if (!painted || Math.hypot(s[0] - painted[0], s[1] - painted[1]) >= 1) {
        ctx.lineTo(...s)
        painted = s
      }
      last = p
    }
    ctx.stroke()
    if (ps.length) {
      const p = screen(ps[ps.length - 1])
      ctx.beginPath()
      ctx.arc(...p, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  if (state.point) {
    const p = screen(state.point)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(...p, 7, 0, Math.PI * 2)
    ctx.stroke()
  }
  $('scale').textContent = `View width ≈ ${((w / state.zoom) * 40075).toFixed(1)} km at equator`
}
function select(id, autoFit = true) {
  state.selected = id
  state.page = 0
  state.point = null
  $('journey').value = id
  const j = state.journeys.find((j) => key(j) === id)
  $('detail').textContent = j
    ? `${j.vessel} · ${j.provider} · ${j.instrument}. ${date(j.startAtMs)} to ${date(j.endAtMs)}. ${j.samples.toLocaleString()} observations, ${j.minDepthM}–${j.maxDepthM} m. Vessel ID: ${j.vesselId}. Segment: ${j.journeyId}.`
    : 'Showing all matching journeys.'
  table()
  if (autoFit) fit()
  else draw()
}
function filters() {
  if (!visible().some((j) => key(j) === state.selected)) state.selected = ''
  $('journey').replaceChildren()
  $('journey').add(new Option('All matching journeys', ''))
  $('legend').replaceChildren()
  const vessels = new Set()
  for (const j of visible()) {
    const o = document.createElement('option')
    o.value = key(j)
    o.textContent = `${j.vessel} · ${date(j.startAtMs)} · ${j.samples} points`
    $('journey').append(o)
    if (!vessels.has(j.vesselId)) {
      const s = document.createElement('span')
      s.style.borderColor = color(j)
      s.textContent = j.vessel
      $('legend').append(s)
      vessels.add(j.vesselId)
    }
  }
  select(state.selected)
}
function inspect(p) {
  state.point = p
  $('point-detail').textContent =
    `${p.vessel} · ${p.depthM} m · ${date(p.observedAtMs)} · ${p.latitude.toFixed(7)}, ${p.longitude.toFixed(7)} · ${p.provider} · ${p.instrument}`
  draw()
}
function table() {
  const ps = state.tracks.get(state.selected) || []
  state.page = Math.min(state.page, Math.max(0, Math.ceil(ps.length / 100) - 1))
  $('rows').replaceChildren()
  for (const p of ps.slice(state.page * 100, state.page * 100 + 100)) {
    const tr = document.createElement('tr')
    tr.tabIndex = 0
    for (const v of [
      date(p.observedAtMs),
      p.depthM,
      p.latitude.toFixed(7),
      p.longitude.toFixed(7)
    ]) {
      const td = document.createElement('td')
      td.textContent = String(v)
      tr.append(td)
    }
    tr.onclick = () => inspect(p)
    tr.onkeydown = (e) => {
      if (e.key === 'Enter') inspect(p)
    }
    $('rows').append(tr)
  }
  $('page').textContent = ps.length
    ? `${state.page + 1} / ${Math.ceil(ps.length / 100)} · ${ps.length.toLocaleString()} original measurements`
    : 'Select a journey'
  $('previous').disabled = state.page === 0
  $('next').disabled = (state.page + 1) * 100 >= ps.length
}
async function load() {
  const generation = ++state.generation
  $('status').textContent = 'Loading journey catalog…'
  try {
    const data = await get('journeys')
    if (generation !== state.generation) return
    state.journeys = data.journeys
    state.tracks.clear()
    for (const f of ['vessel', 'provider', 'instrument']) {
      const selected = $(f).value
      $(f).replaceChildren(new Option('All ' + (f === 'vessel' ? 'vessels' : f + 's'), ''))
      const entries = new Map(
        state.journeys.map((j) => [
          String(j[f === 'vessel' ? 'vesselId' : f]),
          f === 'vessel' ? j.vessel : j[f]
        ])
      )
      for (const [id, label] of entries) $(f).add(new Option(label, id))
      $(f).value = entries.has(selected) ? selected : ''
    }
    filters()
    let completed = 0
    const pending = [...state.journeys]
    async function worker() {
      while (pending.length && generation === state.generation) {
        const j = pending.shift(),
          ps = []
        let after = 0
        do {
          const q = new URLSearchParams({
            vessel: j.vesselId,
            journey: j.journeyId,
            after: String(after)
          })
          const r = await get('journey?' + q)
          if (generation !== state.generation) return
          ps.push(...r.points)
          after = r.next
        } while (after)
        ps.sort((a, b) => a.observedAtMs - b.observedAtMs || a.id - b.id)
        state.tracks.set(key(j), ps)
        completed++
        $('status').textContent = `Loaded ${completed} / ${state.journeys.length} journey segments`
        draw()
      }
    }
    await Promise.all([worker(), worker(), worker()])
    if (generation !== state.generation) return
    $('status').textContent =
      `${state.journeys.length} journey segments · ${[...state.tracks.values()].reduce((n, ps) => n + ps.length, 0).toLocaleString()} depth observations cached on the server`
    table()
    draw()
  } catch (e) {
    if (generation === state.generation) $('status').textContent = e.message
  }
}
for (const f of ['vessel', 'provider', 'instrument', 'from', 'through']) $(f).onchange = filters
$('journey').onchange = () => select($('journey').value)
$('show-all').onclick = () => select('')
$('fit').onclick = fit
$('refresh').onclick = load
function zoom(factor) {
  state.zoom = Math.max(100, Math.min(1e10, state.zoom * factor))
  draw()
}
$('in').onclick = () => zoom(2)
$('out').onclick = () => zoom(0.5)
$('previous').onclick = () => {
  state.page--
  table()
}
$('next').onclick = () => {
  state.page++
  table()
}
canvas.onwheel = (e) => {
  e.preventDefault()
  zoom(Math.exp(-e.deltaY * 0.002))
}
canvas.onkeydown = (e) => {
  if (['+', '=', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault()
    if (e.key === '-') zoom(0.5)
    else if (e.key === '+' || e.key === '=') zoom(2)
    else {
      state.center[0] +=
        (e.key === 'ArrowLeft' ? -50 : e.key === 'ArrowRight' ? 50 : 0) / state.zoom
      state.center[1] += (e.key === 'ArrowUp' ? -50 : e.key === 'ArrowDown' ? 50 : 0) / state.zoom
      draw()
    }
  }
}
let pointer
canvas.onpointerdown = (e) => {
  pointer = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    startX: e.clientX,
    startY: e.clientY
  }
  canvas.setPointerCapture(e.pointerId)
}
canvas.onpointermove = (e) => {
  if (!pointer || pointer.id !== e.pointerId) return
  state.center[0] -= (e.clientX - pointer.x) / state.zoom
  state.center[1] -= (e.clientY - pointer.y) / state.zoom
  pointer.x = e.clientX
  pointer.y = e.clientY
  draw()
}
canvas.onpointerup = (e) => {
  if (!pointer) return
  const click = Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY) < 5
  pointer = null
  if (!click) return
  const rect = canvas.getBoundingClientRect(),
    x = e.clientX - rect.left,
    y = e.clientY - rect.top
  let best = null,
    distance = 15
  for (const j of shown())
    for (const p of state.tracks.get(key(j)) || []) {
      const s = screen(p),
        d = Math.hypot(s[0] - x, s[1] - y)
      if (d < distance) {
        best = { j, p }
        distance = d
      }
    }
  if (best) {
    select(key(best.j), false)
    inspect(best.p)
  }
}
canvas.onpointercancel = () => {
  pointer = null
}
new ResizeObserver(draw).observe(canvas)
load()
