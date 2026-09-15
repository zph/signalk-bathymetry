# Crowd Depth implementation review

Reviewed 2026-09-15, public commit
[`e152360d4801c3c1b6b52f0f4d5c96afffad42d5`](https://github.com/openwatersio/crowd-depth/tree/e152360d4801c3c1b6b52f0f4d5c96afffad42d5).
Static source review only; production credentials, deployment configuration,
archive acceptance and actual vessel installations were not inspected.

## Conclusion

It implements a real contribution pipeline with useful durability and metadata
work, but I would not use it unchanged for this boat. There are depth-reference,
position-reference, processing-provenance, and retry issues worth resolving first.

## Findings

### High: history depth is mislabeled as waterline depth

[`sources/history.ts`](https://github.com/openwatersio/crowd-depth/blob/e152360d4801c3c1b6b52f0f4d5c96afffad42d5/packages/signalk-plugin/src/sources/history.ts)
returns the configured depth path value directly. Unlike `streams/live.ts`, it
does not add transducer immersion or keel draft. `reporters/noaa.ts` always emits
`verticalReferenceOfDepth: Waterline`. Example: 5 m below the transducer with
0.5 m immersion becomes 5 m labeled waterline, rather than 5.5 m. The plugin
prefers the history source when one is available, so this is a primary path.

### High: transducer-position claim can be false

[`streams/transforms.ts`](https://github.com/openwatersio/crowd-depth/blob/e152360d4801c3c1b6b52f0f4d5c96afffad42d5/packages/signalk-plugin/src/streams/transforms.ts)
skips position correction when heading is missing/nonfinite, even when sensor
offsets are nonzero. Metadata still says `vesselPositionReferencePoint:
Transducer`. North heading (zero radians) is also discarded by the truthiness
check in `toPrecision`, preventing correction for those live records.
Keep GNSS positions and offsets as raw evidence, or accurately declare each
corrected/uncorrected group and its processing.

### Medium: processing history and installation changes are obscured

[`reporters/noaa.ts`](https://github.com/openwatersio/crowd-depth/blob/e152360d4801c3c1b6b52f0f4d5c96afffad42d5/packages/signalk-plugin/src/reporters/noaa.ts)
sets `dataProcessed: false` although the live collector adds a vertical offset,
the exporter can move positions, and history uses one-second minimum depths,
first positions and average headings. The SQLite rows retain depth and heading
but not a historical sensor/offset configuration snapshot. Applying today's
configuration to old measurements can misrepresent the installation that
produced them. B-12 prefers raw evidence and documentation of processing.

### Medium: some retryable failures become terminal

[`api.ts`](https://github.com/openwatersio/crowd-depth/blob/e152360d4801c3c1b6b52f0f4d5c96afffad42d5/packages/api/src/api.ts)
and [`sweep.ts`](https://github.com/openwatersio/crowd-depth/blob/e152360d4801c3c1b6b52f0f4d5c96afffad42d5/packages/api/src/sweep.ts)
treat every HTTP 4xx as permanent, including 429 and 408. They can store a terminal
failure marker while returning success to the vessel; the vessel checkpoints
the range. Data remains in backend storage, but automatic delivery stops.
The default sweep scans only the last 14 days, so extended outages can also
strand older queued data. Distinguish durable receipt from NOAA acceptance,
retry transient status codes, and provide backlog recovery beyond that window.

### Medium: live quality/source controls lag the history path

[`streams/live.ts`](https://github.com/openwatersio/crowd-depth/blob/e152360d4801c3c1b6b52f0f4d5c96afffad42d5/packages/signalk-plugin/src/streams/live.ts)
does not apply the configured source selectors used by the history path.
Its stale-position check rejects old fixes but accepts arbitrarily future fixes.
The `if (!value)` check is not finite-positive-depth validation, and missing
timestamps silently become current receipt time. These can produce misleading
position/depth pairing without explicit quality flags.

## What it does well

- Stable UUID and optional omission of name/MMSI from contribution metadata.
- Sensor metadata, CSB 3.1 convention and EPSG:4326 declarations.
- Local SQLite WAL fallback and history-based collection; batched checkpointing.
- Backend persistence before forwarding, authentication and upload-size limits.
- Retryable-failure markers and an hourly recovery sweep.
- Source selection and reordered-column handling in the history reader.

## Operational questions for the maintainer

1. Is the service currently onboarded for production DCDB submissions under
   `SIGNALK`, and can a recent accepted submission ID/archive file be supplied?
   The code's default NOAA URL is a test endpoint; the deployed environment may
   override it, which cannot be determined from this review.
2. How are owners notified about stored-but-rejected submissions and how are
   old failed batches recovered after the sweep window?
3. Will the depth/position reference and processing issues above be corrected?

Reference requirements:
[IHO B-12](https://iho.int/uploads/user/pubs/bathy/B_12_CSB-Guidance_Document-Edition_3.0.0_Final.pdf),
[NOAA onboarding](https://www.ncei.noaa.gov/iho-data-centre-digital-bathymetry),
and [CSB schema](https://github.com/CI-CMG/csbschema).
