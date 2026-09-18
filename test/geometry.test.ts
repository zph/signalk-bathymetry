import assert from 'node:assert/strict'
import test from 'node:test'
import { correctGeometry } from '../src/geometry'
import { normalizeConfig } from '../src/config'
import type { AlignedPosition } from '../src/position'
const position: AlignedPosition = { value: { latitude: 0, longitude: 0 }, timestampMs: 1000, source: 'gps', horizontalSigmaM: 3, inputTimeSkewMs: 0, method: 'exact', fixTimestampMs: 1000 }
const angles = (roll: number, pitch: number, timestampMs = 1000) => ({ value: { roll, pitch }, timestampMs, source: 'imu' })
const heading = (value: number, timestampMs = 1000) => ({ value, timestampMs, source: 'compass' })
const config = normalizeConfig({ attitudeCorrection: true })
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`)

test('level beam retains vertical range; roll/pitch shorten it and shift the footprint', () => {
  close(correctGeometry(10, position, 1000, angles(0, 0), heading(0), config)!.verticalDepthM, 10)
  const roll = correctGeometry(10, position, 1000, angles(Math.PI / 6, 0), heading(0), config)!
  close(roll.verticalDepthM, 10 * Math.cos(Math.PI / 6))
  close(roll.metadata.eastOffsetM, -5)
  close(roll.metadata.northOffsetM, 0)
  assert.ok(roll.horizontalSigmaM > 3)
  assert.ok(roll.verticalGeometrySigmaM > 0)
  const pitch = correctGeometry(10, position, 1000, angles(0, Math.PI / 6), heading(Math.PI / 2), config)!
  close(pitch.metadata.eastOffsetM, 5)
  close(pitch.metadata.northOffsetM, 0)
  const both = correctGeometry(10, position, 1000, angles(Math.PI / 6, Math.PI / 6), heading(0), config)!
  close(both.verticalDepthM, 7.5)
})

test('verified lever arm rotates in 3D and immersion changes about the rotation origin', () => {
  const measured = normalizeConfig({ attitudeCorrection: true, recordingInstallation: {
    offsetsVerified: true, antennaToTransducerForwardM: 2, antennaToTransducerStarboardM: 1, antennaToTransducerDownM: 3,
    transducerForwardM: 0, transducerStarboardM: 1, transducerDownM: 0
  } })
  const result = correctGeometry(10, position, 1000, angles(Math.PI / 6, 0), heading(0), measured)!
  close(result.metadata.draftChangeM, 0.5)
  close(result.surfaceOffsetM, 1)
  close(result.metadata.northOffsetM, 2)
  close(result.metadata.eastOffsetM, Math.cos(Math.PI / 6) - 1.5 - 5)
  assert.equal(result.metadata.leversVerified, true)
})

test('missing/stale attitude or heading and invalid geometry never produce corrected soundings', () => {
  assert.equal(correctGeometry(10, position, 1000, undefined, heading(0), config), undefined)
  assert.equal(correctGeometry(10, position, 1000, angles(0, 0, 0), heading(0), config), undefined)
  assert.equal(correctGeometry(10, position, 1000, angles(0, 0), undefined, config), undefined)
  assert.equal(correctGeometry(10, position, 1000, angles(0, 0), heading(0, 0), config), undefined)
  assert.equal(correctGeometry(10, position, 1000, angles(Math.PI / 2, 0), heading(0), config), undefined)
  assert.equal(correctGeometry(10, position, 1000, angles(0, 0), heading(0), normalizeConfig({ attitudeCorrection: true, depthPath: 'environment.depth.belowSurface' })), undefined)
  assert.equal(correctGeometry(10, position, 1000, angles(0, 0), heading(0), normalizeConfig({ attitudeCorrection: true, recordingInstallation: { beamMountRollDegrees: 'bad' } })), undefined)
})
