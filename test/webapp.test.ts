import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('author styles cannot override hidden inspection panels', () => {
  const styles = readFileSync(join(process.cwd(), 'public/styles.css'), 'utf8')
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/)
})
