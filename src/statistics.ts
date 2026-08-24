export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? Number.NaN
  const left = sorted[middle - 1] ?? Number.NaN
  const right = sorted[middle] ?? Number.NaN
  return (left + right) / 2
}

export function medianAbsoluteDeviation(values: readonly number[], center = median(values)): number {
  return median(values.map((value) => Math.abs(value - center)))
}

export function robustSigma(values: readonly number[]): number {
  if (values.length < 2) return 0
  return 1.4826 * medianAbsoluteDeviation(values)
}

export function weightedGeometricMean(parts: readonly { value: number; weight: number }[]): number {
  let weightedLog = 0
  let totalWeight = 0
  for (const part of parts) {
    if (part.weight <= 0) continue
    const value = Math.min(1, Math.max(0.001, part.value))
    weightedLog += Math.log(value) * part.weight
    totalWeight += part.weight
  }
  return totalWeight > 0 ? Math.exp(weightedLog / totalWeight) : 0
}
