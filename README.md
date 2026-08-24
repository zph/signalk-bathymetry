# Signal K Local Bathymetry

A Signal K server plugin that records source-aware depth evidence, reduces it
to a configured chart datum, detects contradictory seabed regimes, and exposes
translucent Freeboard-SK overlays.

> Supplemental local estimate only. This is not an official hydrographic
> survey and must not be used as the primary source for navigation.

The full design and safety model are in
[docs/BATHYMETRY_SPEC.md](docs/BATHYMETRY_SPEC.md).

## Implemented MVP

- Live synchronization of position, depth, tide, SOG, course, and heave.
- Below-keel, below-surface, or below-transducer datum reduction with explicit
  vessel offsets and uncertainty.
- Hybrid underway sampling: at least every configured interval or distance.
- Robust stationary 60-second windows instead of 1 Hz duplicate storage.
  Windows retain accepted/rejected counts and improve precision with capped,
  diminishing weight; independent visits/days still drive confirmation.
- Crash-safe SQLite/WAL evidence storage, logical append-only raw records,
  fingerprint deduplication, and versioned QC classifications.
- Signal K History API backfill in bounded chunks, with provenance downgraded
  when the provider cannot return original `$source` metadata.
- Automatic 30-day History API backfill after startup when the local evidence
  store is empty, with delayed provider discovery and bounded retries.
- Fixed metric surface cells with robust pass estimates, uncertainty,
  confidence, age decay, and asymmetric seabed-change handling.
- Transparent PNG layers for depth, confidence, age, and change.
- Two read-only Signal K chart resources discovered by Freeboard-SK:
  chart-datum depth and tide-adjusted current under-keel safety.
- HTTP inspection API, administrator backfill/reprocessing endpoints, OpenAPI
  metadata, and a small status/legend web app.

## Requirements and development

- Signal K Server with Node.js 22.13 or newer.
- A tide source publishing `environment.tide.heightNow`. Its datum and station
  identity must match the plugin configuration.

```sh
npm install
npm test
npm pack
```

For a development installation, point Signal K at this package using the
server's normal local-plugin workflow, enable **Local Bathymetry**, then set the
measured vessel offsets and tide datum before recording.

## Important configuration

- `depthPath` and optional `depthSource`: the authoritative sounder input.
- `surfaceToKeelM` / `surfaceToTransducerM`: measured vertical geometry.
- `targetDatum`, `tideStationId`, and `tideStationName`: never inferred or
  silently mixed.
- `dangerUnderKeelM`: conservative clearance at or below which the
  tide-adjusted overlay uses distinct danger colors; default 0.75 m.
- `stationaryWindowSeconds` and `stationaryMinimumSamples`: robust aggregation
  at anchor; defaults 60 seconds and 10 samples.
- `baseCellMeters`, `recencyHalfLifeDays`, and change-confirmation thresholds.
- `autoBackfillWhenEmpty`, `autoBackfillDays`, and
  `autoBackfillDelaySeconds`; defaults are enabled, 30 days, and 15 seconds.

The tide-adjusted hazard calculation is:

```text
conservative under-keel clearance
  = datum bottom depth + tide height - waterline-to-keel
    - 1.645 × combined vertical uncertainty
```

Chart-datum mode does not claim current clearance. It displays stored depth at
the named zero datum; its danger boundary is the required water column at zero
tide (`surfaceToKeelM + dangerUnderKeelM`).

## Freeboard-SK

Open Freeboard's chart/layer selector and enable one of:

- **Local Bathymetry — &lt;datum&gt;** for the normal zero-datum surface.
- **Local Bathymetry — Tide-adjusted now** for conservative current under-keel
  safety coloring.

Both are PNG XYZ overlays with alpha baked from `overlayOpacity`, so the normal
chart remains visible. Disable the selected resource to return to the normal
chart. Gray stippling marks lower confidence and magenta cell borders mark a
suspected or confirmed change.

## API

Read-only routes are mounted below `/plugins/signalk-bathymetry`:

```text
GET /status
GET /soundings?bbox=&from=&to=&qc=
GET /cells?bbox=west,south,east,north
GET /cells/lookup?latitude=&longitude=
GET /changes?since=
GET /projection?at=now
GET /tiles/{z}/{x}/{y}.png?layer=depth|confidence|age|change&mode=datum|water
```

Administrator-only operations:

```text
POST /admin/backfill  {"from":"...","to":"..."}  # maximum 31 days/request
POST /admin/reprocess
```

## Storage decision

SQLite is the operational store and is sufficient for the MVP. Integer-scaled
timestamps, coordinates, and measurements already compress repeated structure
well at this volume, while SQLite provides transactions and point/cell queries
without another runtime dependency.

Parquet is intentionally not required. It remains a future archive/export
option for multi-year analytics or interchange. If added, use
`DELTA_BINARY_PACKED` for integer/time columns, dictionaries for repeated source
and datum strings, and Zstandard page compression; keep SQLite authoritative.
