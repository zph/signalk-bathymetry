import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observedContours } from '../src/noaa-csb-contours'
import { mercatorToLonLat } from '../src/geo'

test('contours require four populated cells from a single survey and close zoom',()=>{
  const points=[[0,0,2],[1,0,8],[1,1,8],[0,1,2]].map(([x,y,depth])=>({
    ...mercatorToLonLat((x!+.5)*20,(y!+.5)*20),depthM:depth!,fileUuid:'same',uniqueId:'v',
    observedAtMs:0,platform:'',provider:'',instrument:''
  }))
  assert.ok(observedContours(points,15,16384,16383).length>0)
  assert.equal(observedContours(points.slice(0,3),15,16384,16383).length,0)
  assert.equal(observedContours(points,12,2048,2047).length,0)
  points[0]!.fileUuid='other'
  assert.equal(observedContours(points,15,16384,16383).length,0)
})
