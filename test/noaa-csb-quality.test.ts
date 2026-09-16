import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessCsbSoundings } from '../src/noaa-csb-quality'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('Golden Gate archived tile: disputed shallow run cannot become a trusted shoal', () => {
  // Captured from local NOAA archive tile 16/10472/25321, September 16, 2026.
  const rows = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/golden-gate-disputed-track.json'), 'utf8')) as Array<[number,number,number,number,string,string]>
  const points = rows.map(([longitude,latitude,depthM,observedAtMs,platform,fileUuid]) => ({
    longitude,latitude,depthM,observedAtMs,platform,fileUuid,uniqueId:platform,provider:'',instrument:''
  }))
  const assessed = assessCsbSoundings(points)
  const disputed = assessed.filter(s => s.depthM < 3)
  assert.equal(disputed.length, 51)
  assert.ok(disputed.every(s => !s.contourEligible))
  assert.ok(assessed.some(s => s.depthM > 80 && s.contourEligible))
  assert.deepEqual(assessed.map(s => s.depthM), points.map(s => s.depthM), 'never rewrite archived observations')
})

function reading(i: number, depthM: number, platform = 'one') {
  return { longitude: -122.4 + i * .00001, latitude: 37.8, depthM, platform,
    uniqueId: platform, fileUuid: platform, observedAtMs: i * 1000, provider: '', instrument: '' }
}

test('isolated shallow and deep spikes are retained but cannot generate contours', () => {
  for (const spike of [.3, 200]) {
    const results = assessCsbSoundings(Array.from({length: 9}, (_, i) => reading(i, i === 4 ? spike : 20)))
    assert.equal(results[4]!.depthM, spike)
    assert.equal(results[4]!.contourEligible, false)
    assert.ok(results[4]!.qualityReasons.includes('isolated_track_spike'))
    assert.ok(results[3]!.reliability > results[4]!.reliability)
  }
})

test('a continuous slope and a sustained shallow patch are not isolated spikes', () => {
  for (const depths of [[10,12,14,16,18,20,22,24,26],[20,20,20,2,2,2,20,20,20]]) {
    assert.ok(assessCsbSoundings(depths.map((d,i) => reading(i,d))).every(s => s.contourEligible))
  }
})

test('independent vessels improve reliability and a dense dissenting vessel gets one vote', () => {
  const results = assessCsbSoundings([
    ...Array.from({length: 100}, (_,i) => reading(i % 10,200,'bad')),
    ...Array.from({length: 9}, (_,i) => reading(i,20,'a')),
    ...Array.from({length: 9}, (_,i) => reading(i,20.3,'b')),
    ...Array.from({length: 9}, (_,i) => reading(i,20.1,'c'))
  ])
  assert.ok(results.filter(s => s.platform === 'bad').every(s => !s.contourEligible))
  assert.ok(results.some(s => s.platform === 'a' && s.reliability >= .7))
})

test('stable source bias across separate cells is identified without silently changing depths', () => {
  const points = Array.from({length: 10}, (_,i) => ['a','b','c','offset'].map(platform => ({
    ...reading(i, platform === 'offset' ? 23 : 20,platform), longitude: -122.4 + i * .001
  }))).flat()
  const biased = assessCsbSoundings(points).filter(s => s.platform === 'offset')
  assert.ok(biased.every(s => s.sourceOffsetM === 3 && !s.contourEligible && s.depthM === 23))
})

test('metadata changes baseline reliability, erroneous flags always exclude contours', () => {
  const [unknown] = assessCsbSoundings([reading(0,20)])
  const [known] = assessCsbSoundings([{...reading(0,20),quality:{qualification:'datum_corrected'}}])
  const [flagged] = assessCsbSoundings([{...reading(0,20),quality:{erroneous:true}}])
  assert.ok(known!.reliability > unknown!.reliability)
  assert.equal(flagged!.reliability,0)
  assert.equal(flagged!.contourEligible,false)
})

test('aggregate extremes are explained while the robust center remains usable', () => {
  const [s] = assessCsbSoundings([{...reading(0,20),minDepthM:.3,maxDepthM:200,p10DepthM:19.8,p90DepthM:20.2}])
  assert.equal(s!.contourEligible,true)
  assert.ok(s!.qualityReasons.includes('isolated_shallow_extreme_retained'))
  assert.ok(s!.qualityReasons.includes('isolated_deep_extreme_retained'))
})
