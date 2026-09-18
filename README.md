# Signal K Local Bathymetry

A Signal K server plugin that records source-aware depth evidence, reduces it
to a configured chart datum, detects contradictory seabed regimes, and exposes
interactive vector cells to Signal K chartplotters.

> Supplemental local estimate only. This is not an official hydrographic
> survey and must not be used as the primary source for navigation.

The full design and safety model are in
[docs/BATHYMETRY_SPEC.md](docs/BATHYMETRY_SPEC.md).
The proposed multi-vessel contribution, validation, storage, and reciprocal
sharing design is in
[docs/SHARED_BATHYMETRY_SPEC.md](docs/SHARED_BATHYMETRY_SPEC.md).

## Implemented MVP

- Independent raw sounding journal, tide snapshots and correction on read,
  installation metadata, administrator review downloads, explicit publication
  opt-in, and durable export batches with confirmed-receipt cursors. See
  [contribution instructions](docs/CONTRIBUTING_CSB.md) and
  [Crowd Depth review](docs/CROWD_DEPTH_REVIEW.md).

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
- Interactive S-57-style MVT depth cells with meter-native depths, confidence,
  uncertainty, evidence counts, recency, and change metadata.
- One read-only chart-datum MVT resource discovered by Freeboard-SK and
  Binnacle, with a provider-owned vector portrayal for Freeboard.
- A separate, offline-first NOAA Crowdsourced Bathymetry sounding layer. Region
  imports cache actual point depths in SQLite, discard invalid NOAA sentinel
  values, retain source metadata, and never interpolate across unmeasured gaps.
- HTTP inspection API, administrator backfill/reprocessing endpoints, OpenAPI
  metadata, and a vector quality-control web app with live tide projection.

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

See [position alignment and attitude geometry](docs/POSITION_AND_ATTITUDE.md) for
timestamp handling, horizontal confidence, beam correction, and installation requirements.

## Important configuration

- `depthPath` and optional `depthSource`: the authoritative sounder input. New installations default
  to the direct `environment.depth.belowTransducer` measurement; below-keel and below-surface inputs
  remain supported and retain their reference on every record.
- `surfaceToKeelM` / `surfaceToTransducerM`: measured vertical geometry.
- `targetDatum`, `tideStationId`, and `tideStationName`: never inferred or
  silently mixed.
- `dangerUnderKeelM`: conservative clearance at or below which the
  tide-adjusted overlay uses distinct danger colors; default 0.75 m.
- `stationaryWindowSeconds` and `stationaryMinimumSamples`: robust aggregation
  at anchor; defaults 60 seconds and 10 samples.
- `baseCellMeters`, `recencyHalfLifeDays`, and change-confirmation thresholds.
- `showDepthLabels` and `depthLabelRelativeSize`; defaults show normal-size
  depth numbers. Relative size is bounded from 0.5 to 2.
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

Open Freeboard's chart selector and enable **Local Bathymetry Cells -
&lt;datum&gt;**. The chart is an MVT resource with S-57 `DEPARE` and `SOUNDG`
layers. Freeboard uses the plugin's vector style, including `overlayOpacity`,
`showDepthLabels`, and `depthLabelRelativeSize`.

Binnacle discovers the same chart resource, applies its day, dusk, or night-red
portrayal, converts meter-native depth attributes at the display edge, and
opens the cell evidence inspector on click. It also honors the label visibility
and relative-size properties carried in every vector tile.

Only chart-datum depth is advertised as a chart resource. A chartplotter can
cache a stationary vector tile indefinitely, so advertising a
`Tide-adjusted now` chart would eventually present stale water depth. The
plugin's quality-control web app retains tide-adjusted depth, confidence,
recency, and change views because it refreshes the underlying cells and tide
projection while open.

## API

Read-only routes are mounted below `/plugins/signalk-bathymetry`:

```text
GET /status
GET /soundings?bbox=&from=&to=&qc=
GET /cells?bbox=west,south,east,north
GET /cells/lookup?latitude=&longitude=
GET /changes?since=
GET /projection?at=now
GET /vector-style.json
GET /tiles/{z}/{x}/{y}.pbf?mode=datum|water
GET /csb/status
GET /csb/soundings?bbox=west,south,east,north
GET /csb/tiles/{z}/{x}/{y}.pbf
```

Administrator-only operations:

```text
POST /admin/backfill  {"from":"...","to":"..."}  # maximum 31 days/request
POST /admin/reprocess
POST /admin/csb/import {"bbox":[west,south,east,north],"maxFiles":2000}
```

The NOAA import starts in the background. Poll `/csb/status` for discovery,
download, invalid-row, and completion counts. Binnacle and other chart clients
discover **NOAA Crowdsourced Bathymetry** as a chart
resource, disabled by default. Its depths are raw observations with unknown
vertical datum and vessel offsets. They remain visually and structurally
separate from the plugin's tide-reduced local surface and are supplemental
reference data only, not navigation data.

Open **Explore NOAA vessel journeys and individual depths** on the plugin home
page, or open `journeys.html` directly. Filter by vessel, provider, instrument,
and collection dates, select a source-file journey segment, and inspect exact
observed depths on the map or in the paginated measurement table. Tracks retain
visible strokes and endpoint dots at low zoom. Gaps longer than five minutes,
implausible jumps, and antimeridian crossings break the drawn line.

`GET /csb/journeys` lists cached vessel/segment metadata. `GET /csb/journey`
accepts `vessel`, `journey`, and an optional `after` cursor and returns up to
5,000 original observations with a `next` cursor. These endpoints require the
same read access as the depth layer. The explorer reads cached data only.

Enable **NOAA Crowdsourced Bathymetry** in Binnacle's chart list and expand its
child layers. **Coverage** shows translucent red haze below zoom 9, including at
world zoom. **Tracks** shows the finer indexed survey paths from zoom 9. Their
rendered strokes progressively taper from 1.5 at zoom 9 to 0.6 at zoom 15 and
closer, keeping the overlay from overpowering chart detail as you zoom in. The
footprint is NOAA's indexed track coverage, not depth, a safety boundary, or proof
that every record contains a valid sounding. Rendering uses NOAA's map export
rather than a record-limited feature query. PNG tiles use the ordinary chart tile
cache plus a one-day server disk cache, with cached fallback during upstream
outages.

Enable the **Depths** facet to automatically download observations
when visible tiles are requested at zoom 12 or closer. Downloads are coalesced by
zoom-12 area, serialized, and retained in SQLite across restarts. Full source files
are retained so panning elsewhere on the same vessel journey does not lose data.
Older viewport-clipped cache entries are downloaded again on demand. Automatic
imports are bounded to 50 files per area and 64 MB per file; use the manual importer
for denser areas. `/csb/status` reports pending viewport areas and download errors.
Zoomed-out coverage never triggers bulk depth downloads. The parent layer is disabled
by default, with all three facets selected for when it is enabled. Each facet has
independent visibility and opacity under the master layer. Binnacle migrates the old
two-layer device settings to these facets, preserving hidden depths and existing opacity.
Other chart clients can still consume the sounding vector tile URL directly.

## Storage decision

SQLite is the operational store and is sufficient for the MVP. Integer-scaled
timestamps, coordinates, and measurements already compress repeated structure
well at this volume, while SQLite provides transactions and point/cell queries
without another runtime dependency.

Parquet is intentionally not required. It remains a future archive/export
option for multi-year analytics or interchange. If added, use
`DELTA_BINARY_PACKED` for integer/time columns, dictionaries for repeated source
and datum strings, and Zstandard page compression; keep SQLite authoritative.
