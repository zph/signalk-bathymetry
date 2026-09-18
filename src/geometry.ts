import { offsetPosition, fresh, type AlignedPosition } from './position'
import type { BathymetryConfig, TimestampedValue } from './types'

export interface Attitude { roll: number; pitch: number }
type Vector = { forward: number; starboard: number; down: number }

/** Signal K: positive roll = starboard down, positive pitch = bow up. */
export function rotate(vector: Vector, roll: number, pitch: number): Vector {
  const cR = Math.cos(roll), sR = Math.sin(roll), cP = Math.cos(pitch), sP = Math.sin(pitch)
  const side = cR * vector.starboard - sR * vector.down
  const down = sR * vector.starboard + cR * vector.down
  return { forward: cP * vector.forward + sP * down, starboard: side, down: -sP * vector.forward + cP * down }
}

export function correctGeometry(rangeM: number, position: AlignedPosition, atMs: number,
  attitude: TimestampedValue<Attitude> | undefined, heading: TimestampedValue<number> | undefined,
  config: BathymetryConfig) {
  if (!config.attitudeCorrection) return undefined
  const installation = config.recordingInstallation
  const keys = ['antennaToTransducerForwardM', 'antennaToTransducerStarboardM', 'antennaToTransducerDownM',
    'transducerForwardM', 'transducerStarboardM', 'transducerDownM', 'beamMountRollDegrees', 'beamMountPitchDegrees'] as const
  if (config.depthPath !== 'environment.depth.belowTransducer') return undefined
  if (!fresh(attitude, atMs, config.attitudeMaxAgeSeconds) || !fresh(heading, atMs, config.attitudeMaxAgeSeconds)) return undefined
  const { roll, pitch } = attitude.value
  if (![roll, pitch, heading.value, rangeM].every(Number.isFinite) || rangeM <= 0) return undefined
  if (Math.abs(roll) > Math.PI / 3 || Math.abs(pitch) > Math.PI / 3) return undefined
  const leversVerified = installation.offsetsVerified === true && keys.slice(0, 6).every(key => typeof installation[key] === 'number' && Number.isFinite(installation[key]))
  const measured = (key: string) => leversVerified ? Number(installation[key]) : 0
  const rad = Math.PI / 180
  const mount = rotate({ forward: 0, starboard: 0, down: 1 }, Number(installation.beamMountRollDegrees ?? 0) * rad, Number(installation.beamMountPitchDegrees ?? 0) * rad)
  const beam = rotate(mount, roll, pitch)
  if (![beam.forward, beam.starboard, beam.down].every(Number.isFinite)) return undefined
  // Reject beams near the horizon, including the outer edge of their cone.
  const halfBeam = config.beamWidthDegrees * rad / 2
  const tilt = Math.acos(Math.max(-1, Math.min(1, beam.down)))
  if (tilt + halfBeam >= Math.PI / 2) return undefined
  const lever = rotate({ forward: measured('antennaToTransducerForwardM'), starboard: measured('antennaToTransducerStarboardM'), down: measured('antennaToTransducerDownM') }, roll, pitch)
  const originLever = { forward: measured('transducerForwardM'), starboard: measured('transducerStarboardM'), down: measured('transducerDownM') }
  const draftChangeM = rotate(originLever, roll, pitch).down - originLever.down
  const forward = lever.forward + rangeM * beam.forward
  const starboard = lever.starboard + rangeM * beam.starboard
  const east = forward * Math.sin(heading.value) + starboard * Math.cos(heading.value)
  const north = forward * Math.cos(heading.value) - starboard * Math.sin(heading.value)
  const footprintRadiusM = rangeM * Math.sin(halfBeam)
  const angleSigma = config.attitudeSigmaDegrees * rad
  const leverLength = Math.hypot(originLever.forward, originLever.starboard, originLever.down)
  const horizontalSigmaM = Math.hypot(position.horizontalSigmaM, footprintRadiusM,
    angleSigma * (rangeM + Math.hypot(lever.forward, lever.starboard, lever.down)))
  // A single-beam return need not lie on its centerline. Retain the cone's vertical ambiguity.
  const coneVerticalM = rangeM * Math.max(Math.abs(Math.cos(Math.max(0, tilt - halfBeam)) - beam.down),
    Math.abs(Math.cos(tilt + halfBeam) - beam.down))
  return { position: offsetPosition(position.value, east, north),
    verticalDepthM: rangeM * beam.down, surfaceOffsetM: config.surfaceToTransducerM + draftChangeM,
    horizontalSigmaM, verticalGeometrySigmaM: Math.hypot(coneVerticalM, angleSigma * (rangeM * Math.sin(tilt) + leverLength)),
    metadata: { method: 'beam-center-with-cone-uncertainty', leversVerified, rollRad: roll, pitchRad: pitch, headingTrueRad: heading.value,
      attitudeTimestampMs: attitude.timestampMs, attitudeSource: attitude.source, headingTimestampMs: heading.timestampMs, headingSource: heading.source,
      verticalRangeM: rangeM * beam.down, draftChangeM, eastOffsetM: east, northOffsetM: north,
      footprintRadiusM, installation: { ...installation }, beamWidthDegrees: config.beamWidthDegrees } }
}
