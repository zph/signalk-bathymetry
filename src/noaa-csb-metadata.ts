import type { CsbFileMetadata, CsbMetadataQuality } from './noaa-csb'

type JsonObject = Record<string, unknown>
type QualificationSource = Pick<
  CsbMetadataQuality,
  'traceId' | 'metadataLastUpdated' | 's3Uri'
> & { hasTimestamp?: boolean }

export type CsbMetadataLookupState = 'found' | 'missing' | 'unavailable'

export interface CsbMetadataLookupResult {
  file: CsbFileMetadata
  state: CsbMetadataLookupState
}

/** Read file-level quality only from our local archive; never call NOAA Crowbar at render time. */
export async function withLocalCsbMetadata(
  fetcher: typeof fetch,
  archiveBaseUrl: string,
  file: CsbFileMetadata,
  signal?: AbortSignal
): Promise<CsbMetadataLookupResult> {
  try {
    const query = new URLSearchParams({ fileName: file.name })
    const response = await fetcher(
      `${archiveBaseUrl.replace(/\/$/, '')}/api/crowbar/metadata?${query}`,
      signal ? { signal } : undefined
    )
    if (response.status === 404)
      return {
        file: { ...file, quality: unknownQuality('local_archive_metadata_missing') },
        state: 'missing'
      }
    if (!response.ok) throw new Error(`local archive returned HTTP ${response.status}`)
    const body = (await response.json()) as unknown
    if (!isObject(body) || body.fileName !== file.name || !isObject(body.quality))
      throw new Error('local archive returned invalid metadata')
    const quality = archivedQuality(body.quality)
    return { file: { ...file, quality }, state: 'found' }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      file: { ...file, quality: unknownQuality(`local_archive_metadata_unavailable:${detail}`) },
      state: 'unavailable'
    }
  }
}

function archivedQuality(value: JsonObject): CsbMetadataQuality {
  const qualification = text(value.qualification)
  if (!qualification || ![
    'datum_corrected', 'datum_correctable', 'surface_resolved', 'reference_known', 'raw_unknown'
  ].includes(qualification)) throw new Error('local archive returned invalid qualification')
  const score = finiteNumber(value.score)
  if (score === undefined || score < 0 || score > 1)
    throw new Error('local archive returned invalid quality score')
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.filter((reason): reason is string => typeof reason === 'string')
    : []
  const result: CsbMetadataQuality = {
    qualification: qualification as CsbMetadataQuality['qualification'],
    score,
    eligibleForDirectFusion: value.eligibleForDirectFusion === true,
    depthReference: text(value.depthReference) ?? 'raw-observed-datum-unknown',
    reasons,
    rawMetadata: isObject(value.rawMetadata) ? value.rawMetadata : {}
  }
  for (const key of ['traceId', 'metadataLastUpdated', 's3Uri'] as const) {
    const candidate = text(value[key])
    if (candidate !== undefined) result[key] = candidate
  }
  const sounderDraftM = finiteNumber(value.sounderDraftM)
  if (sounderDraftM !== undefined) result.sounderDraftM = sounderDraftM
  for (const key of [
    'draftApplied', 'soundSpeedDocumented', 'positionOffsetsDocumented', 'motionOffsetsApplied'
  ] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  const verticalReductionReference = text(value.verticalReductionReference)
  const verticalReductionMethod = text(value.verticalReductionMethod)
  if (verticalReductionReference !== undefined)
    result.verticalReductionReference = verticalReductionReference
  if (verticalReductionMethod !== undefined) result.verticalReductionMethod = verticalReductionMethod
  return result
}

export function qualifyCsbMetadata(
  metadata: JsonObject,
  source: QualificationSource = {}
): CsbMetadataQuality {
  const depthReference = extractDepthReference(metadata)
  const sounderDraftM = extractSounderDraft(metadata)
  const draftApplied = findBoolean(metadata, 'draftApplied', 'sounderDraftApplied')
  const soundSpeedDocumented = findBoolean(
    metadata,
    'soundSpeedDocumented',
    'soundSpeedApplied'
  )
  const positionOffsetsDocumented = findBoolean(
    metadata,
    'positionOffsetsDocumented',
    'positionOffsetsApplied'
  )
  const motionOffsetsApplied = findBoolean(metadata, 'motionOffsetsApplied')
  const verticalReduction = findProcess(metadata, 'VerticalReduction')
  const verticalReference = text(getCaseInsensitive(verticalReduction ?? {}, 'reference'))
  const verticalMethod = text(getCaseInsensitive(verticalReduction ?? {}, 'method'))
  const normalizedVerticalReference = verticalReference
    ? normalizeDepthReference(verticalReference)
    : undefined
  const reasons: string[] = []
  let qualification: CsbMetadataQuality['qualification'] = 'reference_known'

  if (
    (depthReference === 'chart_datum' || depthReference === 'ellipsoid') &&
    (normalizedVerticalReference === 'chart_datum' ||
      normalizedVerticalReference === 'ellipsoid') &&
    verticalMethod
  ) {
    qualification = 'datum_corrected'
    reasons.push('documented_vertical_reduction')
  } else if (!depthReference) {
    qualification = 'raw_unknown'
    reasons.push('depth_reference_missing')
  } else {
    let surfaceResolvable = depthReference === 'waterline'
    if (depthReference === 'transducer') {
      if (draftApplied === true) {
        surfaceResolvable = true
        reasons.push('draft_reported_applied')
      } else if (draftApplied === false && sounderDraftM !== undefined) {
        surfaceResolvable = true
        reasons.push('draft_available_for_application')
      } else reasons.push('transducer_draft_or_applied_state_missing')
    } else if (depthReference === 'keel') reasons.push('waterline_to_keel_offset_missing')
    else if (depthReference === 'waterline') reasons.push('waterline_reference')
    else if (depthReference === 'chart_datum' || depthReference === 'ellipsoid')
      reasons.push('vertical_reduction_not_fully_documented')
    else reasons.push(`unsupported_depth_reference:${depthReference}`)

    const hasTimestamp = source.hasTimestamp ?? findValue(metadata, 'startTime') !== undefined
    if (surfaceResolvable && hasTimestamp) {
      qualification = 'datum_correctable'
      reasons.push('timestamp_available_for_water_level_reduction')
    } else if (surfaceResolvable) {
      qualification = 'surface_resolved'
      reasons.push('timestamp_missing')
    }
  }

  const scoreByQualification: Record<CsbMetadataQuality['qualification'], number> = {
    datum_corrected: 0.95,
    datum_correctable: 0.72,
    surface_resolved: 0.52,
    reference_known: 0.35,
    raw_unknown: 0.18
  }
  let score = scoreByQualification[qualification]
  if (soundSpeedDocumented === true) score += 0.01
  if (positionOffsetsDocumented === true) score += 0.01
  if (motionOffsetsApplied === true) score += 0.01
  score = Math.min(0.99, score)

  return {
    qualification,
    score,
    eligibleForDirectFusion: qualification === 'datum_corrected',
    depthReference: depthReference ?? 'raw-observed-datum-unknown',
    reasons,
    rawMetadata: metadata,
    ...(source.traceId === undefined ? {} : { traceId: source.traceId }),
    ...(source.metadataLastUpdated === undefined
      ? {}
      : { metadataLastUpdated: source.metadataLastUpdated }),
    ...(source.s3Uri === undefined ? {} : { s3Uri: source.s3Uri }),
    ...(sounderDraftM === undefined ? {} : { sounderDraftM }),
    ...(draftApplied === undefined ? {} : { draftApplied }),
    ...(soundSpeedDocumented === undefined ? {} : { soundSpeedDocumented }),
    ...(positionOffsetsDocumented === undefined ? {} : { positionOffsetsDocumented }),
    ...(motionOffsetsApplied === undefined ? {} : { motionOffsetsApplied }),
    ...(verticalReference === undefined ? {} : { verticalReductionReference: verticalReference }),
    ...(verticalMethod === undefined ? {} : { verticalReductionMethod: verticalMethod })
  }
}

export function unknownQuality(reason = 'metadata_not_loaded'): CsbMetadataQuality {
  return {
    qualification: 'raw_unknown',
    score: 0.18,
    eligibleForDirectFusion: false,
    depthReference: 'raw-observed-datum-unknown',
    reasons: [reason],
    rawMetadata: {}
  }
}

function extractDepthReference(metadata: JsonObject): string | undefined {
  const crs = getCaseInsensitive(metadata, 'crs')
  if (isObject(crs)) {
    const direct = text(getCaseInsensitive(crs, 'vertical'))
    if (direct) return normalizeDepthReference(direct)
    const properties = getCaseInsensitive(crs, 'properties')
    if (isObject(properties)) {
      const nested = text(getCaseInsensitive(properties, 'vertical'))
      if (nested) return normalizeDepthReference(nested)
    }
  }
  const explicit = text(findValue(metadata, 'referencePointForDepth', 'depthReference'))
  return explicit ? normalizeDepthReference(explicit) : undefined
}

function normalizeDepthReference(value: string): string {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const aliases: Record<string, string> = {
    transducer: 'transducer',
    echosounder: 'transducer',
    sounder: 'transducer',
    waterline: 'waterline',
    surface: 'waterline',
    keel: 'keel',
    chartdatum: 'chart_datum',
    mllw: 'chart_datum',
    mlw: 'chart_datum',
    lat: 'chart_datum',
    ellipsoid: 'ellipsoid',
    gnss: 'gnss'
  }
  return aliases[compact] ?? (compact || 'unknown')
}

function extractSounderDraft(metadata: JsonObject): number | undefined {
  for (const value of walk(metadata)) {
    if (!isObject(value)) continue
    const sensorType = text(getCaseInsensitive(value, 'type', 'sensorType'))?.toLowerCase()
    if (!sensorType || !['sounder', 'echo sounder', 'echosounder', 'multibeam'].includes(sensorType))
      continue
    const draft = finiteNumber(getCaseInsensitive(value, 'draft', 'sounderDraft'))
    if (draft !== undefined && draft >= 0) return draft
  }
  const draft = finiteNumber(findValue(metadata, 'sounderDraft'))
  return draft !== undefined && draft >= 0 ? draft : undefined
}

function findProcess(metadata: JsonObject, processType: string): JsonObject | undefined {
  for (const value of walk(metadata)) {
    if (!isObject(value)) continue
    if (text(getCaseInsensitive(value, 'type'))?.toLowerCase() !== processType.toLowerCase()) continue
    const detail = getCaseInsensitive(value, 'detail')
    return isObject(detail) ? detail : value
  }
  return undefined
}

function findBoolean(value: unknown, ...names: string[]): boolean | undefined {
  const candidate = findValue(value, ...names)
  if (typeof candidate === 'boolean') return candidate
  if (typeof candidate === 'string' && candidate.toLowerCase() === 'true') return true
  if (typeof candidate === 'string' && candidate.toLowerCase() === 'false') return false
  return undefined
}

function findValue(value: unknown, ...names: string[]): unknown {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  for (const candidate of walk(value)) {
    if (!isObject(candidate)) continue
    for (const [key, nested] of Object.entries(candidate)) {
      if (wanted.has(key.toLowerCase())) return nested
    }
  }
  return undefined
}

function* walk(value: unknown): Generator<unknown> {
  yield value
  if (Array.isArray(value)) {
    for (const nested of value) yield* walk(nested)
  } else if (isObject(value)) {
    for (const nested of Object.values(value)) yield* walk(nested)
  }
}

function getCaseInsensitive(value: JsonObject, ...names: string[]): unknown {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  for (const [key, nested] of Object.entries(value)) {
    if (wanted.has(key.toLowerCase())) return nested
  }
  return undefined
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}
