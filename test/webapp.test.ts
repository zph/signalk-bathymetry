import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('author styles cannot override hidden inspection panels', () => {
  const styles = readFileSync(join(process.cwd(), 'public/styles.css'), 'utf8')
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/)
})

test('quality-control map renders live vectors without requesting PNG bathymetry', () => {
  const app = readFileSync(join(process.cwd(), 'public/app.js'), 'utf8')
  const html = readFileSync(join(process.cwd(), 'public/index.html'), 'utf8')
  assert.doesNotMatch(app, /\.png/)
  assert.doesNotMatch(html, /bathy-tiles/)
  assert.match(html, /id="bathy-vectors"/)
  assert.match(app, /depthLabelRelativeSize/)
})

test('measurement details distinguish sensor reference, offset, surface, datum, and tide', () => {
  const app = readFileSync(join(process.cwd(), 'public/app.js'), 'utf8')
  for (const label of [
    'Sensor reading',
    'Waterline offset',
    'Depth below surface',
    'Datum-reduced depth',
    'Tide correction'
  ]) {
    assert.match(app, new RegExp(label))
  }
})
