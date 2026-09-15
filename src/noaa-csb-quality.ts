import type { CsbSounding } from './noaa-csb'

export interface AssessedSounding extends CsbSounding {
  reliability: number
  qualityReasons: string[]
  contourEligible: boolean
  sourceOffsetM?: number
}

const median = (values: number[]) => {
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const deviation = (values: number[], center: number) => median(values.map(v => Math.abs(v - center)))
const source = (s: CsbSounding) => s.platform.trim().toLowerCase()
const pass = (s: CsbSounding) => `${source(s)}:${s.fileUuid}:${Math.floor(s.observedAtMs / 86_400_000)}`

/** Reliability of the observed reading, not a probability of safe clearance or known datum. */
export function assessCsbSoundings(input: readonly CsbSounding[]): AssessedSounding[] {
  const samples: AssessedSounding[] = input.filter(s => Number.isFinite(s.depthM) && s.depthM > 0 &&
    s.depthM <= 12_000 && Number.isFinite(s.latitude) && Math.abs(s.latitude) <= 85.051129 &&
    Number.isFinite(s.longitude) && Math.abs(s.longitude) <= 180).map(s => {
    const qualification = s.quality?.qualification
    const baseline = qualification === 'datum_corrected' ? .7 : qualification === 'surface_resolved' ? .58 :
      qualification === 'datum_correctable' || qualification === 'reference_known' ? .53 : .45
    const rejected = s.quality?.erroneous === true
    const reasons = [qualification ? `metadata_${qualification}` : 'vertical_reference_unknown']
    const spread = (s.p90DepthM ?? s.depthM) - (s.p10DepthM ?? s.depthM)
    const variable = spread > Math.max(2, s.depthM * .3)
    if (variable) reasons.push('variable_readings_in_cell')
    if (rejected) reasons.push('source_flagged_erroneous')
    if (s.minDepthM !== undefined && s.minDepthM < (s.p10DepthM ?? s.depthM) - Math.max(2, s.depthM * .25)) {
      reasons.push('isolated_shallow_extreme_retained')
    }
    if (s.maxDepthM !== undefined && s.maxDepthM > (s.p90DepthM ?? s.depthM) + Math.max(2, s.depthM * .25)) {
      reasons.push('isolated_deep_extreme_retained')
    }
    return { ...s, reliability: rejected ? 0 : baseline - (variable ? .1 : 0), qualityReasons: reasons,
      contourEligible: !rejected }
  })
  const latitude = samples.length ? median(samples.map(s => s.latitude)) : 0
  const metersPerDegree = 111_320
  const longitudeScale = metersPerDegree * Math.cos(latitude * Math.PI / 180)
  const point = (s: CsbSounding) => [s.longitude * longitudeScale, s.latitude * metersPerDegree] as const
  const distance = (a: CsbSounding, b: CsbSounding) => {
    const p = point(a), q = point(b)
    return Math.hypot(p[0] - q[0], p[1] - q[1])
  }
  const passes = new Map<string, AssessedSounding[]>()
  for (const s of samples) {
    if (!source(s) || !Number.isFinite(s.observedAtMs)) continue
    const key = pass(s)
    const group = passes.get(key) ?? []
    group.push(s)
    passes.set(key, group)
  }
  for (const group of passes.values()) {
    group.sort((a, b) => a.observedAtMs - b.observedAtMs)
    for (let i = 2; i + 2 < group.length; i++) {
      const s = group[i]!
      const neighbors = [group[i - 2]!, group[i - 1]!, group[i + 1]!, group[i + 2]!]
      if (neighbors.some(n => distance(s, n) > 80 || Math.abs(s.observedAtMs - n.observedAtMs) > 120_000)) continue
      const depths = neighbors.map(n => n.depthM)
      const center = median(depths)
      const tolerance = Math.max(2, center * .35, 4 * deviation(depths, center))
      if (Math.abs(s.depthM - center) > tolerance && Math.max(...depths) - Math.min(...depths) < tolerance) {
        s.reliability = Math.min(s.reliability, .15)
        s.contourEligible = false
        s.qualityReasons.push('isolated_track_spike')
      } else if (s.contourEligible) {
        s.reliability += .12
        s.qualityReasons.push('locally_consistent_track')
      }
    }
  }
  // One vote per vessel per 50 m cell, regardless of ping density. No distant-neighbor searches.
  const cells = new Map<string, Map<string, AssessedSounding[]>>()
  for (const s of samples) {
    if (!s.contourEligible || !source(s)) continue
    const [x, y] = point(s)
    const key = `${Math.floor(x / 50)}:${Math.floor(y / 50)}`
    const cell = cells.get(key) ?? new Map<string, AssessedSounding[]>()
    const observations = cell.get(source(s)) ?? []
    observations.push(s)
    cell.set(source(s), observations)
    cells.set(key, cell)
  }
  const residuals = new Map<string, number[]>()
  for (const cell of cells.values()) {
    const centers = new Map([...cell].map(([id, readings]) => [id, median(readings.map(s => s.depthM))]))
    // A steep local slope is not evidence of a faulty vessel. Do not compare
    // cell medians when a vessel itself observes substantial terrain variation.
    if ([...cell].some(([id, readings]) => deviation(readings.map(s => s.depthM), centers.get(id)!) >
      Math.max(1.5, centers.get(id)! * .15))) continue
    for (const [id, readings] of cell) {
      const others = [...centers].filter(([other]) => other !== id).map(([, depth]) => depth)
      if (others.length < 2) continue
      const reference = median(others)
      const tolerance = Math.max(1.5, reference * .15)
      if (deviation(others, reference) > tolerance) continue
      const residual = centers.get(id)! - reference
      for (const s of readings) {
        if (Math.abs(s.depthM - reference) <= tolerance) {
          s.reliability += .18
          s.qualityReasons.push('independent_vessels_agree')
        } else {
          s.reliability = Math.min(s.reliability, .25)
          s.contourEligible = false
          s.qualityReasons.push('independent_vessels_disagree')
        }
      }
      for (const key of new Set(readings.map(pass))) {
        const values = residuals.get(key) ?? []
        values.push(residual)
        residuals.set(key, values)
      }
    }
  }
  for (const s of samples) {
    const differences = residuals.get(pass(s))
    if (differences && differences.length >= 5) {
      const offset = median(differences)
      if (Math.abs(offset) > 1.5 && deviation(differences, offset) < Math.max(.5, Math.abs(offset) * .2)) {
        s.sourceOffsetM = offset
        s.reliability = Math.min(s.reliability, .3)
        s.contourEligible = false
        s.qualityReasons.push('systematic_pass_offset_unresolved')
      }
    }
    s.reliability = Math.round(Math.max(0, Math.min(s.quality?.qualification === 'datum_corrected' ? .95 : .8,
      s.reliability)) * 100) / 100
  }
  return samples
}
