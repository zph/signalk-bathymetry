'use strict'
const element = id => document.getElementById(id)
async function request(action, body = {}) {
  const response = await fetch(`/plugins/signalk-bathymetry/admin/recording/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'Sign in to Signal K as an administrator to use recording controls.' : await response.text())
  return response.json()
}
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function refresh() {
  const status = await request('status')
  element('status').textContent = `${status.count} raw records. Publication ${status.publicationEnabled ? 'enabled' : 'disabled'}. Confirmed through record ${status.acknowledgedThroughId}.${status.capture.error ? ` Recording error: ${status.capture.error}` : ''}`
  element('consent').checked = status.publicationEnabled
}
function action(id, fn) {
  element(id).onclick = async () => {
    element('error').textContent = ''; element(id).disabled = true
    try { await fn() } catch (error) { element('error').textContent = error.message }
    finally { element(id).disabled = false }
  }
}
action('sample', async () => download('bathymetry-review-sample.geojson', await request('sample', { afterId: Number(element('after').value) })))
action('raw', async () => download('bathymetry-raw-records.json', await request('read', { afterId: Number(element('after').value) })))
action('save', async () => { await request('consent', { enabled: element('consent').checked, license: 'CC0-1.0' }); await refresh() })
action('prepare', async () => {
  const batch = await request('prepare'); download('bathymetry-export-batch.json', batch)
  element('batch').value = batch.batchId || ''; await refresh()
})
action('ack', async () => {
  await request('acknowledge', { batchId: element('batch').value, receivedByPartner: element('received').checked })
  element('received').checked = false; await refresh()
})
refresh().catch(error => { element('error').textContent = error.message })
