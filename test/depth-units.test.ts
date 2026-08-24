import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDepthDisplayUnits, revisionFor } from '../src/depth-units'

test('resolves the Signal K depth preference without evaluating arbitrary formulas', () => {
  const units = parseDepthDisplayUnits(
    {
      name: 'Nautical Imperial (US)',
      categories: {
        depth: {
          baseUnit: 'm',
          targetUnit: 'foot',
          displayFormat: '0.0',
          formula: 'value * 3.280839895013124',
          symbol: 'foot'
        }
      }
    },
    1234
  )
  assert.equal(units.targetUnit, 'foot')
  assert.equal(units.symbol, 'ft')
  assert.equal(units.decimals, 1)
  assert.equal(units.metersToDisplayFactor, 3.280839895013124)
  assert.equal(units.resolvedAtMs, 1234)
  assert.match(revisionFor(units), /^foot-/)

  assert.throws(
    () =>
      parseDepthDisplayUnits(
        {
          categories: {
            depth: { baseUnit: 'm', targetUnit: 'unsafe', formula: 'process.exit()' }
          }
        },
        1234
      ),
    /non-linear conversion/
  )
})
