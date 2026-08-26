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
- Fixed metric pointy-top hex cells with robust pass estimates, uncertainty,
  confidence, age decay, and asymmetric seabed-change handling. Touching cells
  render as one continuous measured swath without internal grid borders.
- Transparent PNG layers for depth, confidence, age, and change, with optional
  conservative depth numbers centered in cells at high zoom.
- Interactive S-57-style MVT depth cells with meter-native depths, confidence,
  uncertainty, evidence counts, recency, and change metadata.
- Two read-only Signal K chart resources discovered by Freeboard-SK:
  chart-datum depth and tide-adjusted current under-keel safety.
- Matching Freeboard information-layer resources that forcibly refresh their
  visible XYZ tiles every 10 minutes, including while the map remains open.
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
- `showDepthLabels` and `depthLabelMinZoom`; defaults show numbers from zoom 19.
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
chart. At zoom 19 and above, each sufficiently large hex is labeled with its
conservative depth: datum depth in the datum layer, or tide-projected water
depth in the tide-adjusted layer. Labels use clean contrast-aware digits without
an outline, grow with zoom, and continue across XYZ tile seams without clipping.
Depths below 10 display units retain the configured decimal precision; depths
of 10 or more omit decimals. All labels round down so they never overstate depth.
The measured swath perimeter and change outlines use anti-aliased geometric
strokes rather than pixel-traced borders. Gray stippling marks lower confidence and
magenta cell borders mark a suspected or confirmed change.

When zooming out below level 18, the renderer uses a world-aligned overview
pyramid instead of letting 5 m cells disappear below one pixel. Overview hexes
remain roughly 32 screen pixels wide so they are visible around Freeboard's
vessel icon: 20 m at zoom 18, 40 m at zoom 17, 80 m at zoom 16, 160 m at zoom
15, and 320 m at zoom 14. Native 5 m cells remain at zoom 19 and above. Their
depth/clearance color is controlled by the shallowest accepted conservative
source cell, never an average. Sparse source coverage lowers overview confidence
and activates the gray stipple so a large abstracted hex is not presented as a
fully surveyed area. `X-Bathymetry-Cell-Meters` reports the rendered resolution.

The plugin reads Signal K's resolved `depth` unit preference once after startup,
caches it in plugin data, and converts only the rendered numbers. Storage, QC,
API fields, and safety settings remain SI meters. For a tide-adjusted overlay
that must update while Freeboard remains open and stationary, enable **Local
Bathymetry — Tide-adjusted live** under Freeboard's information/overlay layers.
Freeboard actively clears and reloads that layer every 10 minutes. The matching
chart resources remain available, but Freeboard's chart tile cache does not
periodically evict already-visible tiles.

Binnacle also discovers two **Local Bathymetry Cells** chart resources. These
use live MVT tiles with S-57 `DEPARE` and `SOUNDG` source layers, so Binnacle
renders the cell fills and depth labels with its ENC portrayal and can inspect a
cell on click. Depth attributes remain in meters inside the tile. Binnacle
converts them to the active Signal K depth unit only when displaying labels and
cell details. The existing PNG resources remain available for Freeboard
compatibility and for the confidence, age, and change raster views.

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
GET /tiles/{z}/{x}/{y}.pbf?mode=datum|water
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
