import type { BathymetryConfig, Position, TimestampedValue } from './types'

export interface AlignedPosition extends TimestampedValue<Position> {
  horizontalSigmaM: number
  inputTimeSkewMs: number
  method: 'exact' | 'interpolated' | 'projected'
  fixTimestampMs: number
}

export function fresh<T>(sample: TimestampedValue<T> | undefined, atMs: number, ageSeconds: number): sample is TimestampedValue<T> {
  return !!sample && Math.abs(sample.timestampMs - atMs) <= ageSeconds * 1000
}

/** Small offsets on the sphere; longitude wraps correctly at the dateline. */
export function offsetPosition(origin: Position, eastM: number, northM: number): Position {
  const radius = 6_371_008.8
  const distance = Math.hypot(eastM, northM) / radius
  const bearing = Math.atan2(eastM, northM)
  const lat = origin.latitude * Math.PI / 180
  const lon = origin.longitude * Math.PI / 180
  const latitude = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(bearing))
  const longitude = lon + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat), Math.cos(distance) - Math.sin(lat) * Math.sin(latitude))
  return { latitude: latitude * 180 / Math.PI, longitude: ((longitude * 180 / Math.PI + 540) % 360) - 180 }
}

export class PositionBuffer {
  private fixes: TimestampedValue<Position>[] = []
  constructor(private readonly config: BathymetryConfig) {}

  add(fix: TimestampedValue<Position>): boolean {
    const latest = this.fixes.at(-1)
    // Ignore old deliveries rather than rewinding the movement detector or switching sources back.
    if (latest && fix.timestampMs <= latest.timestampMs) return false
    const reset = !!latest && (latest.source !== fix.source || fix.timestampMs - latest.timestampMs > this.config.segmentGapSeconds * 1000)
    if (reset) this.fixes = []
    this.fixes.push(fix)
    const cutoff = fix.timestampMs - Math.max(10_000, 4 * this.config.maxLiveTimeSkewSeconds * 1000)
    this.fixes = this.fixes.filter(item => item.timestampMs >= cutoff).slice(-256)
    return reset
  }

  at(atMs: number, sog?: TimestampedValue<number>, cog?: TimestampedValue<number>, project = false): AlignedPosition | undefined {
    const maxSkewMs = this.config.maxLiveTimeSkewSeconds * 1000
    const before = [...this.fixes].reverse().find(fix => fix.timestampMs <= atMs)
    const after = this.fixes.find(fix => fix.timestampMs >= atMs)
    const sigma = this.config.positionSigmaM
    if (before?.timestampMs === atMs) return { ...before, horizontalSigmaM: sigma, inputTimeSkewMs: 0, method: 'exact', fixTimestampMs: before.timestampMs }
    if (before && after && atMs - before.timestampMs <= maxSkewMs && after.timestampMs - atMs <= maxSkewMs) {
      const fraction = (atMs - before.timestampMs) / (after.timestampMs - before.timestampMs)
      const longitudeDelta = ((after.value.longitude - before.value.longitude + 540) % 360) - 180
      const skewMs = Math.max(atMs - before.timestampMs, after.timestampMs - atMs)
      return {
        value: { latitude: before.value.latitude + fraction * (after.value.latitude - before.value.latitude),
          longitude: ((before.value.longitude + fraction * longitudeDelta + 540) % 360) - 180 },
        timestampMs: atMs, source: before.source, method: 'interpolated', fixTimestampMs: after.timestampMs,
        // Adjacent fixes may share a bias; interpolation must not erase that floor.
        horizontalSigmaM: Math.hypot(sigma, this.config.velocitySigmaMps * skewMs / 1000), inputTimeSkewMs: skewMs
      }
    }
    if (!project || !before || atMs - before.timestampMs > maxSkewMs) return undefined
    if (!fresh(sog, atMs, this.config.motionMaxAgeSeconds) || sog.value < 0) return undefined
    if (sog.value > 0 && !fresh(cog, atMs, this.config.motionMaxAgeSeconds)) return undefined
    const dt = (atMs - before.timestampMs) / 1000
    const distance = sog.value * dt
    const course = cog?.value ?? 0
    return { value: offsetPosition(before.value, distance * Math.sin(course), distance * Math.cos(course)),
      timestampMs: atMs, source: before.source, method: 'projected', fixTimestampMs: before.timestampMs,
      // Include the full projected travel as a conservative allowance for turns/course error.
      horizontalSigmaM: Math.hypot(sigma, this.config.velocitySigmaMps * dt, distance), inputTimeSkewMs: dt * 1000 }
  }
}

/** Keep the observation closest to a ping when auxiliary deltas arrive later. */
export function nearest<T>(atMs: number, a: TimestampedValue<T> | undefined, b: TimestampedValue<T> | undefined): TimestampedValue<T> | undefined {
  if (!a) return b
  if (!b) return a
  return Math.abs(a.timestampMs - atMs) <= Math.abs(b.timestampMs - atMs) ? a : b
}
