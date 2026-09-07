# Shared Signal K Bathymetry: contribution and distribution specification

Status: proposed design

Date: 2026-08-24

This document extends [BATHYMETRY_SPEC.md](BATHYMETRY_SPEC.md). The local evidence
store, local chart, and local offline behavior remain authoritative for the boat.
This design adds an optional contribution and shared-data system without putting
cloud availability in the capture or local-rendering path.

## 1. Decisions at a glance

- Keep `bathymetry.sqlite` as the boat's source of truth. Do not create a second
  50 MB measurement database just for sharing.
- Add an upload high-water mark **and a durable batch ledger** to that database.
  A cursor alone cannot safely represent retries, gaps, corrections, or several
  in-flight batches.
- Materialize compact, immutable Parquet files from eligible SQLite rows into a
  bounded local spool. The spool defaults to 50 MiB and is configurable.
- Upload each object directly to a server-chosen S3 key with a short-lived,
  checksum-bound presigned URL. Measurement bytes do not pass through the API.
- Sign the batch manifest with a per-installation key and a server-issued nonce.
  This provides attribution, tamper evidence, and replay protection, but is not
  evidence that the physical measurement is true.
- Use a general-purpose S3 bucket and S3 Standard as the durable landing zone.
  S3 Express One Zone is optional processing scratch, not the only copy of
  contributed evidence.
- A successful S3 `PUT` is not acceptance. The client completes the batch with
  the control plane; the server verifies, validates, normalizes, and publishes
  it asynchronously.
- Recompute every inexpensive datum/unit/offset calculation on the server. Use
  an unpredictable sample for more expensive validation and independent
  implementation checks.
- Weight one boat once per independent pass/cell. A fast or malicious sender
  cannot win by emitting more points.
- Contributions from a suspect boat go to a private shadow surface returned
  only to that boat. They never affect other users or public aggregates.
- Sharing is reciprocal. Disabling contribution immediately disables shared
  layers and deletes the local shared-data cache; the boat's own data continues
  to work normally.
- Serve immutable spatial bundles from S3/CDN. Redis is an optional read-through
  response cache, never the record of truth and not described as "S3-backed."

## 2. Product contract

### 2.1 Goals

- Pool measurements from many independently configured Signal K installations.
- Preserve raw evidence and enough provenance to correct processing later.
- Normalize observations to explicit, compatible vertical datums.
- Detect sensor faults, setup mistakes, unit mistakes, and deliberate poisoning.
- Make newly captured local data visible immediately to its owner.
- Publish data to other boats only after asynchronous validation.
- Capture, map, and browse previously downloaded data without connectivity.
- Keep upload infrastructure simple, idempotent, inexpensive, and tolerant of
  long periods offline.
- Show uncertainty, freshness, source diversity, and change state rather than
  implying survey-grade certainty.
- Publish privacy-reviewed, versioned scientific snapshots with reproducible
  manifests under an explicit data license.

### 2.2 Non-goals

- Hydrographic certification or replacement of official charts.
- Real-time publication of a newly uploaded sounding to other users.
- Trusting a client because it runs the official open-source plugin.
- Inferring a missing transducer offset or unit and silently treating it as fact.
- Publishing vessel tracks, account identities, or per-boat raw observations.
- Guaranteeing that a modified open-source client cannot retain data it already
  downloaded. The service can enforce future access and the official client can
  erase/hide its cache, but this is reciprocity policy rather than DRM.

## 3. Trust and threat model

The system assumes clients can be buggy or hostile. An attacker can edit the
plugin, fabricate plausible files, create several identities, replay valid data,
lie about calibration, and target a particular shoal or channel. TLS, a valid
Parquet footer, and a logged-in account establish none of the hydrographic facts.

Threats include:

- a feet value labeled as meters, centimeters labeled as meters, double unit
  conversion, sign reversal, or a bad NMEA/Signal K adapter;
- wrong depth reference (`belowKeel`, `belowSurface`, or `belowTransducer`);
- wrong waterline-to-transducer/keel offset, draft, tide datum, tide station, or
  clock;
- sounder no-return sentinels, bottom-lock loss, multipath, vegetation, aeration,
  squat, heel, heave, or stale position joined to a fresh depth;
- replayed tracks, duplicated points, impossible motion, bulk junk, decompression
  bombs, malformed Parquet, cost-amplification uploads, and credential theft;
- coordinated Sybil boats reporting a false shoal or false deepening; and
- accidental consensus around the same common hardware/setup error.

The defense is layered: bounded authorization, immutable evidence, independent
server reduction, per-boat influence caps, cross-track and cross-boat checks,
trusted external anchors where available, delayed promotion, and reversible
quarantine. No single numerical "trust score" is allowed to bypass these gates.

## 4. End-to-end architecture

```mermaid
flowchart LR
  S[Signal K inputs] --> C[Local join, calibration, and QC]
  C --> L[(Local SQLite evidence)]
  L --> M[Batch materializer]
  M --> P[Bounded Parquet spool]
  P -->|presigned PUT| B[(S3 durable landing)]
  A[Auth and batch control API] -->|key, limits, URL| P
  B --> Q[Queue and reconciler]
  Q --> V[Schema, abuse, and calculation validation]
  V --> N[Canonical normalized Parquet]
  N --> G[Multi-resolution cell aggregation]
  G --> O[(Versioned spatial bundles in S3)]
  O --> D[CDN / optional Redis read-through]
  D --> H[(Shared cache on boat)]
  L --> R[Immediate local rendering]
  H --> R
  V --> X[Private shadow surface]
  X -->|same boat only| H
```

The control API handles identity, consent, quota, manifests, presigning, batch
completion, and download authorization. It never proxies the normal Parquet
body. A queue is still required after upload; presigning removes the high-volume
intake service, not validation, accounting, or publication state.

## 5. Identity, consent, and reciprocal access

### 5.1 Identities

On first opt-in, the service issues a revocable installation credential and
opaque identifiers for `account_id`, `installation_id`, and `vessel_id`. Object
keys use server-issued opaque ids, never a client-provided vessel name, MMSI,
Signal K context, or email address. Credentials are stored through the Signal K
server's secret-storage facility where available.

A `sensor_profile_id` identifies one physical sounder/transducer/setup. A
`calibration_id` is immutable and effective over a declared UTC interval. A
calibration change opens a new track/pass and does not rewrite old raw evidence.

Account, installation, vessel, and sensor are separate because replacing a
computer must not look like a new independent boat, while replacing a sensor
must not inherit its predecessor's calibration reputation blindly.

### 5.2 Device signatures and nonces

Each installation generates an Ed25519 keypair at registration. The private key
never leaves the Signal K host; the service binds the public key to the
installation credential. Key rotation creates an auditable successor binding.

Do not sign every sounding independently. That adds substantial storage/CPU and
still cannot prove that an attacker-controlled sensor measured reality. Instead:

- preserve the existing stable row fingerprint when the row is first committed;
- optionally maintain a local append-only hash chain over committed fingerprints
  to detect accidental database rewriting;
- have batch allocation return a single-use random `upload_nonce`; and
- sign a canonical manifest containing the nonce, batch id, Parquet SHA-256,
  exact bytes, row-id/time range, schema version, and calibration-set hash.

The server verifies the signature before acknowledging the S3 object and stores
the signature/public-key version with the batch. The nonce expires and cannot be
used for another object. This prevents network replay and misattribution after
presigning; it does not raise the vessel's hydrographic trust by itself. If the
private key is copied, revoke it and treat both old/new installations as linked
until reviewed.

### 5.3 Explicit consent

The default for existing installs is `sharing.enabled: false` until the operator
accepts a plain-language disclosure covering location/depth collection,
retention, aggregation, redistribution, privacy zones, and deletion policy.
The UI reports the last successful upload, queued rows/bytes, current sharing
state, and last shared-data refresh.

Shared maps and compute-heavy derived capabilities may use the same reciprocal
entitlement, but each capability and any new data use must be named in the
consent version. Consent to contribute bathymetry is not blanket permission for
unrelated commercial profiling.

Optional privacy polygons or time ranges are applied before materialization.
Excluded records remain local and do not count as an error or reduce trust.
The server never returns public per-vessel tracks.

### 5.4 Reciprocity rules

- Own capture, own surface, export, and local APIs always work.
- Shared-data download authorization requires `sharing.enabled=true`, valid
  consent version, and a non-revoked credential.
- Eligibility is willingness to contribute when data exists, not a minimum
  number of boating hours. A new install or a boat on land is still eligible.
- Ordinary offline periods do not end eligibility. Previously downloaded shared
  bundles remain usable while the local setting remains enabled.
- Turning sharing off immediately hides the shared layer, cancels pending
  uploads, revokes future download authorization, and deletes the separate
  shared cache. It does not delete the boat's local evidence.
- [TO INVESTIGATE... costs large recalculations but if partitioned we could shred the sensitive data like ips] Consent withdrawal can also request deletion of prior contributions. The
  server tombstones the vessel, excludes it from the next materialization, and
  removes per-vessel landing objects under the published retention policy.
- A shadow-quarantined boat may continue receiving the normal shared product and
  its own private result. Confirmed abuse may instead revoke all access.

There is no claim that already downloaded aggregates can be remotely erased
from modified clients or backups. This limitation must be disclosed.

## 6. On-boat standardization

### 6.1 Calibration profile

The contribution wizard requires or explicitly marks unknown:

```text
depth path and Signal K $source
sensor/transducer make, model, and stable local identifier when available
declared input unit and source of that declaration
depth reference point
surface-to-transducer and/or surface-to-keel offset
offset measurement method, uncertainty, and effective interval
antenna-to-transducer horizontal lever arm when known
instrument minimum/maximum and no-return sentinel behavior
tide station/model, vertical datum, and uncertainty
firmware/plugin/config versions
```

Signal K normally supplies SI values, but the plugin records that assumption and
tests it. Common scale hypotheses (`0.3048`, `3.28084`, `0.01`, `100`) may raise a
unit warning; they must not silently change historical observations. A proposed
correction requires operator confirmation or strong server-side evidence and a
new versioned calibration.

The wizard should cross-check simultaneous depth paths when available:

```text
below_surface ~= below_transducer + surface_to_transducer
below_surface ~= below_keel + surface_to_keel
```

Paths derived from the same source are consistency checks, not independent
sensors. The UI should encourage a measured waterline offset and a known-depth
or dockside check, record how it was obtained, and assign larger uncertainty to
defaults such as design draft.

When a boat is stationary over a stable bottom for a useful part of a tidal
cycle, raw below-surface water depth should change approximately one-for-one
with tide height, while datum-reduced bottom depth should remain approximately
constant:

```text
slope(raw_below_surface, tide_height) ~= +1
slope(reduced_datum_depth, tide_height) ~= 0
```

This is evidence of internal sensor/time/tide consistency, not proof of the
absolute transducer offset or tide datum. It receives weight only when position,
bottom lock, waves/heave, and seabed stability make the regression meaningful.

### 6.2 Client calculation

Depth is positive downward and tide height is positive upward from the target
datum:

```text
below_surface_m =
  raw_m                                      for belowSurface
  raw_m + surface_to_transducer_m            for belowTransducer
  raw_m + surface_to_keel_m                   for belowKeel

client_datum_depth_m = below_surface_m - tide_height_above_datum_m
```

The row contains the raw input, every operand, claimed units/references, the
client result, uncertainty components, and algorithm versions. The server does
not have to trust the result to reproduce it.

### 6.3 Local preprocessing and upload eligibility

Reuse the existing synchronized smart sampler and stationary-window reduction.
Do not upload every native sounder ping merely because it is available. The
default contribution stream contains the app's accepted time/distance samples
and stationary robust windows.

Before upload, classify records with explicit reason bits:

- schema/range/time/coordinate validity;
- freshness and input time skew;
- instrument min/max and sentinel patterns;
- claimed-unit plausibility;
- rolling median/MAD spike and depth-change-per-meter tests;
- bottom-lock/quality fields where available;
- impossible vessel motion or replay-like duplicate runs; and
- calibration and tide provenance completeness.

Upload locally accepted and quarantined records because the server needs enough
evidence to diagnose systematic setup errors. Hard-invalid/non-finite records
are represented in per-batch rejection counts and reason histograms, not as
unbounded rows. The server always runs its own classification.

To reduce paid cloud compute, the client also includes pass/cell summaries,
rolling residual histograms, unit/offset hypotheses, tide-response diagnostics,
and claimed QC output. These are performance hints. The server verifies all
cheap calculations, recomputes a hidden sample of expensive summaries, and
increases the sample or fully recomputes when any check disagrees. A malicious
client therefore cannot gain trust or publication merely by claiming that it
performed expensive local work.

No client QC decision changes the immediate owner experience: local evidence
and local warnings use the existing local pipeline.

## 7. Local persistence, buffering, and batching

### 7.1 Reuse SQLite; separate evidence from transfer state

Yes, sharing should use the same `raw_soundings` store. Add immutable calibration
and contribution metadata plus these conceptual tables:

```sql
sharing_state (
  singleton, scan_highwater_id, acked_contiguous_id,
  consent_version, last_manifest_version, updated_at_ms
)

sharing_batches (
  batch_id, first_row_id, last_row_id, row_count,
  schema_version, calibration_set_hash, parquet_sha256, parquet_bytes,
  object_key, state, attempts, next_attempt_at_ms,
  created_at_ms, authorized_at_ms, uploaded_at_ms, acknowledged_at_ms,
  last_error
)

sharing_exclusions (
  exclusion_id, kind, effective_from_ms, effective_to_ms, geometry_or_rule
)

shared_bundle_cache (
  bundle_key, dataset_version, datum, resolution_m,
  fetched_at_ms, expires_at_ms, bytes, local_path_or_blob
)
```

Batch state is:

```text
planned -> materialized -> authorized -> uploaded -> acknowledged
                   \-> retry_wait ------------------/
                   \-> cancelled
```

Rows are selected by monotonically increasing local `raw_soundings.id`, not by
observation time. Historical backfill inserted later is therefore still seen.
Ranges may include locally ineligible rows; the batch records row count and
reason summaries, so the cursor need not be contiguous over exported rows.

A single cursor is insufficient: batch A may fail while B succeeds, a process
may crash after `PUT` but before acknowledgement, and a calibration correction
may refer to already uploaded evidence. The cursor/high-water mark makes scanning
cheap; the batch ledger makes it correct. Once every earlier batch is
acknowledged or intentionally excluded, `acked_contiguous_id` advances.

Calibration corrections normally upload a small versioned profile and effective
interval. The server reprocesses raw rows it already has; the boat does not
re-upload all measurements.

### 7.2 What the 50 MiB limit means

`sharing.spoolMaxBytes` defaults to 50 MiB. It limits materialized Parquet files,
checksums, and retry artifacts—not the authoritative local evidence database.
Only bounded chunks are read from SQLite, written to `*.tmp`, fsynced/closed,
atomically renamed, and then uploaded. Acknowledged files are removed.

If the spool reaches 50 MiB, capture and local rendering continue. The exporter
stops materializing new files and resumes from the ledger after space is freed.
It never deletes unuploaded raw evidence merely to satisfy the spool limit.

This makes the default both honest and compact: there is no duplicate 50 MiB
queue of measurements. A deployment that also caps the main local evidence
store needs a separate retention policy. Before pruning local rows, it must
either obtain cloud acknowledgement or create a declared safety-preserving
summary that retains minima, robust spread, counts, time span, and provenance.
Silent FIFO loss is prohibited.

### 7.3 Batch thresholds

Initial tunable defaults:

```yaml
sharing:
  enabled: false
  spoolMaxBytes: 52428800       # 50 MiB
  targetObjectBytes: 8388608    # 8 MiB compressed
  maximumObjectBytes: 16777216  # 16 MiB compressed
  minimumMeasurements: 50000
  maximumPendingAgeHours: 168   # flush a useful small batch after 7 days
  agedBatchMinimumMeasurements: 5000
  minimumObjectBytes: 262144
  uploadConcurrency: 1
```

Materialize when either the estimated compressed size reaches 8 MiB or 50,000
eligible records are pending. Also materialize after seven days when at least
5,000 records exist. Never create an object below 256 KiB unless an operational
repair requires it. These values deliberately trade publication latency for
fewer small S3 objects; observed fleet behavior should tune them.

The default 16 MiB maximum makes restart-from-zero single-part PUT retries
acceptable on typical marine links. Configurations above 100 MB should use
multipart upload with a recorded upload id, consecutive parts, ETags, checksums,
and explicit abort cleanup.

Backoff uses full jitter, respects `Retry-After`, and persists the next attempt.
Loss of DNS, credentials, authorization, or connectivity never blocks capture.

## 8. Contribution Parquet contract

One object contains one vessel and one installation, but may reference several
calibration profiles included in object metadata tables. Rows are ordered by
local evidence id/observation time and grouped into useful row groups.

Core columns include:

```text
schema_version, local_row_id, fingerprint, observed_at_utc, ingested_at_utc
opaque_vessel_id, installation_id, sensor_profile_id, calibration_id
track_id, pass_id, origin, context_hash
latitude_e7, longitude_e7, position_source_hash, horizontal_sigma_mm
depth_raw_scaled, depth_claimed_unit, depth_reference, depth_source_hash
surface_to_keel_mm, surface_to_transducer_mm
tide_height_mm, tide_datum, tide_station_id, tide_method, tide_observed_at_utc
client_below_surface_mm, client_datum_depth_mm, vertical_sigma_mm
sog_mmps, cog_true_urad, heave_mm, input_time_skew_ms
aggregation_kind, sample_count, rejected_sample_count
client_qc_state, client_reason_mask
client_reduction_version, plugin_version, config_profile_hash
```

Human-readable account identity, vessel name, MMSI, and unrestricted JSON are
excluded. Bounded, schema-defined extension columns replace arbitrary payloads.
Strings with high repetition use dictionaries; integer time, coordinate, and
measurement columns use delta encoding where supported; Zstandard level 1 or 3
is selected by hardware benchmarks. Millimeter/e7 quantization is declared in
the schema.

The file footer and an API-side manifest both declare row count, min/max local
row id and time, bounding box, schema/reduction versions, calibration ids,
uncompressed/compressed bytes, and SHA-256. The server treats footer statistics
as untrusted hints until it scans the file.

## 9. Direct-to-S3 protocol

### 9.1 Control flow

1. Client writes the immutable local Parquet object and computes SHA-256.
2. `POST /v1/contribution-batches` sends metadata, exact byte length, checksum,
   row count, time range, coarse bounding region, and schema version. The reply
   includes a single-use `upload_nonce`.
3. The service authenticates consent, applies per-vessel/day storage and request
   quotas, allocates a random `batch_id` and server-owned object key, and returns
   a short-lived presigned `PUT` plus required signed headers.
4. Client uploads directly to S3 with exact `Content-Length`, content type,
   checksum, and batch metadata. Redirects to an arbitrary host are refused.
5. Client signs the canonical manifest including the server nonce, then calls
   `POST /v1/contribution-batches/{batch_id}/complete` with that signature.
6. The service verifies the device signature and nonce, performs `HEAD`, checks
   owner/key/length/checksum, atomically marks the batch uploaded, and enqueues
   validation.
7. Client retains the local object until the service returns an idempotent
   acknowledgement. A timeout repeats complete/status; it does not create a new
   batch.
8. A periodic server reconciler lists manifest rows stuck in `authorized` or
   `uploaded`, recovers missed events, and expires orphaned objects.

The completion transaction/queue is primary. S3 notifications may accelerate
processing but are not the only correctness mechanism. Queue delivery and every
worker are at-least-once, keyed idempotently by `batch_id + checksum`.

### 9.2 Object keys and authorization

Keys are allocated, not accepted from clients:

```text
landing/v=1/account-shard=<hh>/vessel=<opaque-id>/year=2026/month=08/
  batch=<server-uuid>-sha256=<short-hash>.parquet
```

Each URL grants only one `PUT` to one key for a short period. Bucket policy
requires TLS and blocks public access. The signature binds required headers;
the completion endpoint enforces the exact length and checksum again. The
control plane limits object size, outstanding authorizations, bytes/day,
rows/day, requests/day, and coarse geographic/time extent. It can stop issuing
URLs without changing the plugin.

S3 credentials are never shipped to the boat. Encryption at rest is bucket
default SSE-S3 or SSE-KMS. KMS key policy is service-only; a presigned uploader
does not receive general decrypt/list rights.

### 9.3 Why not make S3 Express the landing authority

S3 Express One Zone supports presigned access, Parquet/Athena, checksums, and
multipart operations, but its value is same-AZ, very high request-rate,
single-digit-millisecond access. A boat's internet link dominates a single
8–16 MiB upload, while volunteered raw evidence is valuable and not necessarily
re-creatable after a vessel leaves an area.

Directory-bucket objects reside in one Availability Zone, versioning is not
supported, and lifecycle transition actions to cooler storage classes are not
available. Therefore:

- default landing and canonical stores: general-purpose S3 with regional
  redundancy;
- optional S3 Express: temporary same-AZ validation/compaction scratch or a
  benchmark-proven hot copy; and
- never acknowledge durable ingestion while Express is the only cloud copy.

Relevant AWS behavior is documented in [S3 Express high-performance
workloads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-high-performance.html),
[directory-bucket lifecycle differences](https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-buckets-objects-lifecycle.html),
and [directory-bucket multipart uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-using-multipart-upload.html).

## 10. Server validation and normalization

### 10.1 Validation stages

1. **Envelope:** authorization, checksum, size, Parquet magic/footer, bounded
   row groups/columns/strings, schema allowlist, and decompression/resource
   limits. Parsing occurs in a sandbox with CPU, memory, and wall-time limits.
2. **Every row, cheap:** types, nullability, coordinate/time/range checks,
   duplicate fingerprints, source/calibration references, unit conversion,
   offset algebra, datum reduction, uncertainty floors, and kinematic limits.
3. **Secret deterministic sample, expensive:** at least 100 rows or 1% of a
   normal batch (all rows for a smaller batch), selected with a server-secret
   HMAC after upload, plus every flagged/boundary row. Re-run through an
   independent calculation path and deeper track/neighborhood/reference checks.
4. **Batch/fleet:** error rates, residual distributions, repeated sentinels,
   scale/offset hypotheses, spatial coherence, replay similarity, cross-boat
   crossings, and historical behavior of the sensor/vessel/account.
5. **Canonicalization:** write server-derived raw/normalized columns and QC
   reasons to canonical Parquet. Never copy the client-derived depth directly
   into a public aggregate.

All simple datum calculations should be recomputed for every row; sampling is
an additional defense for expensive validation and implementation diversity,
not a reason to accept the other 99% blindly.

### 10.2 Detecting calibration, scale, and unit errors

Maintain separate residual models for vessel, sensor profile, calibration, tide
model, geographic cell, and epoch. Evidence for a boat-wide setup problem is a
similar additive or multiplicative residual across many unrelated cells and
crossings. Evidence for seabed change is geographically coherent and confirmed
by independent boats/times without the same residual elsewhere.

Test explicit hypotheses such as:

- feet/meters or centimeters/meters scale;
- below-keel labeled below-transducer (approximately constant offset);
- double-applied or omitted surface offset;
- reversed or double-applied tide;
- wrong datum/station with time-varying tide-correlated residual;
- clock offset suggested by tide/position lag; and
- depth-dependent sound-speed or sensor scale error.

Also evaluate the tidal-response regression described in section 6.1. A slope
near `+1` before reduction and `0` after reduction supports internal consistency;
a wrong sign, lag, or magnitude can identify tide, clock, or unit faults. It
does not establish the unknown constant transducer offset.

Do not auto-correct a public contribution from a fleet median alone. Promotion
of a correction requires a trusted reference, a controlled calibration, or
enough independent crossing evidence. Store the inferred correction and its
uncertainty as a new model version so it can be reversed.

Official hydrographic data can anchor scale/datum tests, but its age,
resolution, datum transform, and known seabed mobility limit its weight. It is
not an unquestionable truth surface.

Boats passing along a similar path and giving the same depths plus some offset
correlates that the rise and fall of the floor is being measured the same....
then the transducers need to be inferred for their own depth relative to charts/
tides/other boats with good credibility.

### 10.3 Boat and row states

Row states are versioned:

```text
pending | accepted | quarantined | rejected
```

Vessel/sensor contribution states are:

```text
candidate -> trusted
candidate/trusted -> probation -> shadow_quarantined
shadow_quarantined -> probation/trusted
any -> revoked
```

Transitions use rolling windows and hysteresis, not one bad point. Initial
policy should require repeated failure across at least three batches or a
meaningful minimum row count unless there is a clear security violation. Exact
thresholds are model-versioned and tuned from labeled data.

Should start with manual notification to administrator and a review UI before
shadow quarantine or revocation. Should later do sampled reviews.

`shadow_quarantined` means:

- rows remain available to forensic/reprocessing jobs;
- rows contribute only to a private namespace for that opaque vessel;
- public aggregates and other boats never see them;
- the same vessel receives its private cells merged with normal shared results;
  and
- the client gets useful calibration/unit diagnostics but not detailed abuse
  thresholds that make evasion easy.

This is reversible. Operators can fix a calibration and submit its effective
interval; the service reprocesses prior rows without changing raw evidence.

### 10.4 Preventing point-volume and Sybil attacks

- Collapse dense rows to one robust estimate per boat/pass/cell before any
  cross-boat estimator.
- Cap one boat's total weight in a cell/regime, regardless of installations,
  sensors, or point count.
- Treat accounts/devices with copied tracks, correlated timing, shared
  credentials, or other strong linkage as one trust domain.
- Require independent boats, days, and headings for promotion. A starting public
  rule is two trusted boats for a corroborated shallow observation and three for
  deepening or displacement of an established regime; high-risk channels can
  require more.
- Never let an uncorroborated deep claim increase advertised safe depth.
- Keep uncorroborated shallow claims in a separate "unverified hazard report"
  state rather than silently changing the public surface.
- Compare track physics, coverage shape, GNSS quality, and crossing residuals;
  do not rely on IP address as identity.
- Apply quotas before S3 authorization so abuse cannot create unbounded storage
  or parsing cost.

### 10.5 Operator feedback and web-of-trust limits

Authenticated users may submit a signed cell report such as `matches my pass`,
`likely obstruction`, `unit/datum looks wrong`, or `stale/change suspected`.
Feedback is useful for triage, selecting expert-review samples, and finding
change candidates. It is not a depth vote and never increases advertised safe
depth by itself.

Feedback reputation is scoped by agreement with later independent evidence,
rate limited, linked across installations, and robust against reciprocal voting
rings. A thumbs-up from ten accounts is not equivalent to ten calibrated sensor
crossings. Downvotes quarantine for review; they do not erase raw evidence.

## 11. Cloud data layout and retention

### 11.1 Data zones

| Zone | Contents | Store | Retention / purpose |
| --- | --- | --- | --- |
| Control | identities, consent, batches, checksums, trust state, manifests, tombstones | PostgreSQL or DynamoDB | transactional, backed up, auditable |
| Landing/bronze | exact per-boat upload objects | S3 Standard | immutable quarantine; transition after validation, retain per policy |
| Canonical/silver | raw operands plus server normalization/QC | partitioned Parquet in S3 | long-lived evidence and reprocessing source |
| Aggregate/gold | per-pass and multi-resolution public/private cells | Parquet plus immutable bundle files in S3 | versioned serving and analytics |
| Hot | popular authorized bundle responses | CDN and optional Redis | disposable TTL/LRU cache |
| Boat cache | downloaded shared cells/bundles | separate local SQLite/files | offline use; erased/disabled on opt-out |

Landing is partitioned by opaque vessel/month because it makes consent deletion,
quarantine, quota audit, and replay investigation tractable. Canonical data is
compacted by coarse spatial partition, datum, and time—not by vessel—so normal
queries do not scan millions of tiny per-boat files.

Example canonical layout:

```text
silver/schema=1/datum=MLLW/region=<z8-cell>/year=2026/month=08/part-*.parquet
gold/model=4/datum=MLLW/grid=hex-pointy-v1/resolution=5m/region=<z8-cell>/epoch=.../part-*.parquet
bundles/model=4/datum=MLLW/z=12/x=656/y=1582/version=<hash>.pbf
private/vessel=<opaque-id>/model=4/...
manifests/model=4/datum=MLLW/version=<hash>.json
research/version=<snapshot-id>/manifest.json
```

Compaction targets 128–512 MiB canonical files, removes duplicate batch ids and
rows, and atomically publishes a new manifest only after output verification.
Readers use a manifest/version and never discover correctness by listing an
eventually changing prefix.

Suggested policy, subject to legal/privacy review:

- landing: S3 Standard while pending/recent; after verified canonicalization,
  retain 90 days for incident replay, then expire or archive;
- canonical recent partitions: Standard or Intelligent-Tiering;
- older canonical evidence: lifecycle to Standard-IA/Glacier tiers according to
  reprocessing SLO and cost;
- aggregates and current bundles: Standard behind CDN; retain old versions for
  rollback for at least 30 days; and
- rejected hostile payloads: retain metadata/checksum/reason longer than the
  object; isolate object access and expire it on a short security schedule.

Bronze should be kept indefinitely as long as sensitive data is stored elsewhere
and it should be auto-lifecycled over to less expensive storage.

Canonical silver, not Redis and not an Express scratch copy, is the evidence
source for rebuilding every gold version.

### 11.2 Aggregation levels

Keep sparse observed cells only; do not allocate a global ocean raster. Match
the local grid initially to avoid resampling ambiguity:

| Level | Nominal cell | Purpose | Conservative rule |
| --- | ---: | --- | --- |
| Evidence | point/window | audit and reprocessing | immutable raw operands |
| Pass | 5 m cell/pass | remove point-volume bias | robust within-pass estimate |
| Native | 5 m | close navigation view | robust cross-boat regime; uncertainty |
| Overview 1 | 20 m | harbor overview | shallowest supported native bound |
| Overview 2 | 80 m | coastal overview | shallowest supported child bound |
| Overview 3 | 320 m | regional coverage | shallowest supported child bound |

Each public cell carries at least datum, model/grid version, robust and
conservative depth, vertical/horizontal uncertainty, confidence components,
boat/pass/trust-domain counts, coverage fraction, oldest/newest evidence,
change state, and nearest-observation distance. Overview depth is never a mean;
it uses the shallowest supported conservative child and lowers confidence for
sparse coverage.

Public counts should be bucketed or suppressed where necessary to avoid
reconstructing an individual's track. Raw contributors are never returned.

## 12. Size and capacity model

These are planning assumptions, not measured guarantees. The implementation
gate is a 24-hour representative benchmark on minimum supported hardware.

Assume one contributed record per second while underway after smart sampling,
100 underway hours per active boat/year, and 75 bytes/row in chronological
dictionary/delta/ZSTD Parquet. Use 50–120 bytes/row as the capacity range until
measured.

```text
records per boat-year = 100 * 3600 = 360,000
canonical compressed per boat-year ~= 27 MB at 75 bytes/record
50 MiB Parquet capacity ~= 699,000 records ~= 194 underway hours at 1 Hz
```

| Active contributing boats | Records/year | One Parquet copy at 75 B/row | Bronze + silver planning at 2x | Gold/bundles rough allowance |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.36 billion | 27 GB | 54 GB | 5–20 GB |
| 10,000 | 3.6 billion | 270 GB | 540 GB | 50–200 GB |
| 100,000 | 36 billion | 2.7 TB | 5.4 TB | 0.5–2 TB |

At 2 Hz, double raw/canonical figures. Rich extension columns, poorly grouped
files, high-cardinality strings, and keeping multiple model outputs can also
multiply storage. Spatial overlap reduces gold growth; sparse new coverage
increases it. Model versions should reference shared immutable silver evidence
rather than duplicate it.

For the local SQLite store, indexes and repeated text make bytes/row much larger
than Parquet. A preliminary planning range is 250–600 bytes/record, so a 50 MiB
**SQLite** cap would hold only about 87,000–210,000 rows (24–58 hours at 1 Hz).
This is why the 50 MiB sharing value must describe the compact spool and not
pretend to bound the existing evidence store. Measure `page_count * page_size`,
WAL peaks, Parquet bytes/row, CPU, memory, power, and upload retry cost before
setting a local retention default.

## 13. Serving and offline shared data

### 13.1 Materialized delivery

The normal client requests a version manifest for a viewport/region and datum,
sending versions already cached. The server returns only changed immutable
bundle ids and authorized short-lived download URLs. Bundles contain aggregated
cells, never raw soundings, and are sized for resumable regional refresh rather
than one object per 5 m cell.

Use CDN caching for identical public aggregate bundles. If bbox/API responses
need server-side assembly or private-shadow merging, Redis may cache the final
encoded response by:

```text
dataset_version + entitlement_class + datum + z/x/y + resolution
```

Redis uses TTL/LRU and read-through from durable S3 bundles or a materialized
cell database. A Redis loss causes cache misses, not data loss. For an MVP,
immutable S3 bundles plus CDN and a small manifest database may eliminate the
need for Redis entirely.

### 13.2 Boat-side merge

Downloaded shared bundles live in a table/database separate from local raw
evidence. The renderer composes:

1. the boat's newest local/private cell, visible immediately;
2. the latest cached shared aggregate;
3. explicit provenance labels: `local`, `shared validated`, `shared stale`, or
   `your pending/private`; and
4. the most conservative supported result when layers are fused for safety.

Uploads, validation delays, cloud errors, and shared refreshes do not acquire
SQLite write locks in the capture transaction. Network work is asynchronous and
bounded. While offline the plugin captures and renders local data, accumulates
only ledger state plus bounded spool files, and serves cached shared bundles.

The UI shows the shared dataset version and age. Stale data loses confidence but
does not disappear solely because the network is unavailable.

### 13.3 Scientific snapshots and transparency

DEFERRED

Worldwide scientific reuse should come from immutable, privacy-reviewed
snapshots rather than the contributor-only navigation endpoint. Each release
has a permanent dataset id, license, schema, datum/grid/model documentation,
geographic/time coverage, checksums, software/container versions, calibration
and tide-model version sets, QC reason definitions, known limitations, and a
machine-readable manifest. A DOI can be minted for significant releases.

Public research data contains aggregated cells or appropriately de-identified
evidence at a resolution approved by privacy review. Exact tracks, opaque
vessel ids that remain linkable over time, private-shadow data, installation
signatures, IP data, and account metadata are excluded. Researchers needing
more detail use a reviewed controlled-access process and agree to the same
redistribution/deletion constraints.

Publish aggregate validation statistics and model-change reports so users can
understand how data is used and reproduced without revealing live anti-abuse
thresholds or individual contributors.

## 14. APIs

Minimum control-plane surface:

```text
POST   /v1/installations/register
PUT    /v1/consent
DELETE /v1/consent                     # opt out and optional deletion request
POST   /v1/calibrations
POST   /v1/contribution-batches        # allocate id/key and presign PUT
POST   /v1/contribution-batches/{id}/complete
GET    /v1/contribution-batches/{id}
GET    /v1/contribution-status
GET    /v1/shared/manifests?region=&datum=&versions=
POST   /v1/shared/download-authorizations
POST   /v1/cell-feedback
GET    /v1/research/snapshots
```

Every mutation accepts an idempotency key. Responses have explicit schema and
minimum-client versions. Batch status separates:

```text
authorized | uploaded | validating | accepted | accepted_private |
partially_accepted | rejected | expired
```

Do not expose internal abuse rules. Do expose actionable operator-facing setup
diagnostics such as inconsistent reference, likely unit mismatch, stale tide,
or missing offset.

## 15. Operations, privacy, and safety

- Encrypt in transit and at rest; rotate installation credentials and signing
  keys; keep presign lifetimes short.
- Log control actions and model transitions without copying raw coordinates into
  ordinary application logs.
- Record source IP and a bounded set of request-security fields for presign,
  completion, authentication, and download abuse investigation. Full IP values
  belong in a restricted security log with a short declared retention (an
  initial proposal is 30 days); retain a rotated keyed prefix/hash and aggregate
  counters longer only when necessary. Never place IPs in Parquet evidence,
  public manifests, analytics exports, or application error messages. Access,
  retention, deletion, and legal basis require GDPR/CCPA review.
- Metrics include authorization/upload/ack latency, orphan rate, checksum/schema
  failures, bytes/row, validation CPU, per-reason quarantine, boat-state changes,
  compaction lag, publication age, cache hit rate, and deletion completion.
- Alert on sudden regional depth shifts, one account dominating cells, correlated
  new identities, parser resource-limit events, cost spikes, and publication of
  a gold version with materially changed shallow bounds.
- Canary and diff every new QC/aggregation model against the previous model.
  Require rollback manifests before publication.
- Back up control metadata and canonical manifests cross-AZ/region according to
  recovery objectives. Test rebuilding gold and caches from silver.
- Treat precise track/location data as sensitive personal data. Define region,
  retention, access, deletion, and incident-response policies before public beta.
- Complete a GDPR/CCPA data map and process covering controller/processor roles,
  access/export/deletion requests, consent records, legitimate security-log
  retention, subprocessors, cross-border transfer, and breach response. This
  specification is an engineering plan, not a claim of legal compliance.
- Every shared UI repeats that this is supplemental, uncertified data and shows
  datum, uncertainty, age, and contributor diversity.

Initial service objectives:

- local capture/render: no dependency on cloud and no regression when offline;
- batch allocation API: 99.9% monthly availability;
- durable acknowledgement: only after verified presence in regional S3;
- accepted contribution to shared publication: target under 24 hours, not a
  correctness guarantee; and
- consent opt-out: immediate client disable, immediate future-download denial,
  and server exclusion/deletion within the published privacy SLO.

## 16. Rollout and acceptance gates

### Phase 0: format and hardware benchmark

- Add schema fixtures and golden client/server reduction vectors.
- Measure SQLite and Parquet bytes/row, encode memory/CPU/power, retry behavior,
  and 50 MiB spool enforcement on minimum Signal K hardware.
- Fuzz the Parquet reader and reject oversized footers, row groups, columns, and
  decompressed values safely.

### Phase 1: private direct upload

- Consent, installation credentials, calibration profiles, SQLite batch ledger,
  bounded spool, presigned S3 Standard PUT, checksums, quotas, completion API,
  reconciliation, and a private echo surface.
- No cross-user publication.

### Phase 2: trusted pilot

- Recruit boats with measured offsets and controlled crossing/reference areas.
- Label unit, offset, tide, replay, and sensor-failure cases.
- Tune quarantine hysteresis and demonstrate that one boat/one pass cannot
  dominate a cell.

### Phase 3: reciprocal shared beta

- Publish only cells meeting independent-boat and confidence requirements.
- Ship versioned spatial bundles, offline shared cache, opt-out erasure, private
  shadow behavior, and operator diagnostics.
- Conduct poisoning, Sybil, malformed-file, quota, credential-theft, and consent
  deletion exercises.

### Phase 4: scale and tiering

- Add compaction and lifecycle policies based on observed access/cost.
- Add Redis only if CDN/S3 plus manifest measurements show a material need.
- Benchmark S3 Express as processing scratch only if worker I/O is a demonstrated
  bottleneck.

### Later option: redundant peer computation

If cloud transformation cost becomes material, selected deterministic jobs may
be distributed to several consenting installations, similar to volunteer or
BitTorrent-style compute. This is not part of the initial trust boundary.

A safe design requires content-addressed, sandboxed WASM jobs; declared CPU,
memory, power, bandwidth, and opt-in limits; no account secrets; spatial/time
blinding or public aggregate-only inputs; and at least two or three independent
matching results plus a server spot-check. Inputs and outputs are signed and
addressed by hash, and disagreements go back to trusted compute. Never send
precise private tracks or unvalidated uploads to arbitrary peers. Deterministic
agreement proves computation of supplied inputs, not truth of those inputs.

Production publication is blocked until tests prove:

1. server recomputation detects intentionally wrong units, offsets, tide signs,
   and client-derived results;
2. batch signatures reject a changed manifest, expired/reused nonce, wrong
   installation key, and replayed object;
3. retries/crashes never skip or duplicate logical evidence;
4. spool exhaustion never interrupts capture or deletes unacknowledged evidence;
5. a shadow-quarantined vessel affects only its private response;
6. one boat, dense points, replay, and linked Sybils cannot outvote independent
   contributors;
7. unconfirmed deepening never increases the conservative public depth;
8. opt-out immediately disables shared use in the official client and prevents
   new downloads; and
9. every public aggregate can be reproduced from a declared silver manifest,
   calibration/tide versions, QC model, and code version.

## 17. Open decisions requiring measured or policy input

- Exact consent/deletion retention and whether users may revoke already
  published historical aggregates.
- Geographic residency regions and the account/identity friction acceptable for
  Sybil resistance.
- Which authoritative tide and chart-datum transformations are available in
  each launch region.
- Minimum independent boats for public shoaling reports in high-risk areas.
- Whether 5/20/80/320 m remains the global grid or the cloud adopts a standard
  hierarchical index with a versioned local conversion.
- Parquet writer choice on Node 22 and its actual delta/ZSTD support on target
  ARM systems.
- Measured threshold at which small-file compaction, CDN, Redis, or S3 Express
  pays for its operational complexity.
- Scientific snapshot license, privacy resolution, DOI/release cadence, and
  controlled-access terms.
- Whether per-row local hash chaining adds enough forensic value beyond the
  immutable row fingerprint and signed batch manifest to justify its migration
  and recovery complexity.
