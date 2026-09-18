# Position alignment and attitude geometry

Live capture retains the original GPS fix, depth, attitude and heading in the
independent raw journal. Mapped soundings are derived separately.

## Position at depth time

A bounded, timestamp-ordered GPS buffer interpolates between same-source fixes.
A depth event waits up to `maxLiveTimeSkewSeconds` (default 2 seconds, plus the
flush timer interval) for a following fix. At expiry, a preceding fix may be
projected using fresh SOG and true COG; zero speed needs no course. Otherwise the
mapped sounding is withheld. Raw recording continues. Exact-time fixes need no
velocity. Interpolation wraps longitude at the antimeridian. Source changes and
long GPS gaps clear pending interpolation; late fixes cannot rewind capture.

`positionSigmaM` is an **estimated**, configurable per-axis uncertainty floor,
not measured receiver accuracy (default 3 m). Interpolation retains this floor;
projection adds velocity uncertainty and the full projected travel distance to
allow for turns. Neither process removes persistent GNSS bias. No Kalman filter
is introduced by this change.

Stationary detection checks speed freshness (`motionMaxAgeSeconds`, default 2 s).
Without fresh underway speed, movement requires three distinct GPS fixes whose
displacement exceeds the stationary radius plus twice the combined anchor/current
position uncertainty. The anchor persists across stationary windows so sustained
movement cannot be hidden by repeatedly resetting the reference. The movement
check uses vessel position, not the attitude-shifted echo footprint.

## Horizontal uncertainty on the map

Soundings and cells retain `horizontalSigmaM`; the sounding API also exposes
`positionMethod` and `geometry`, and MVT includes `BATHY_HORIZONTAL_SIGMA_M`.
Stationary windows retain the position floor and add footprint/position spread.
Cell confidence uses the largest horizontal uncertainty of the evidence controlling
the displayed depth, without dividing by ping count. Confidence is capped by
`min(1, (ground_cell_width / (2 * horizontal_sigma))^2)`. Ground width accounts for
Mercator scale at the cell latitude. This is a fitness heuristic, not a probability.
Cells wider in uncertainty diameter than their ground width carry
`horizontal_uncertainty_exceeds_cell`.

Evidence stays in the cell containing its estimated position. We do not populate
neighboring cells with fabricated observations or claim precise cell membership.
This reduces false confidence, but cannot eliminate every cell-boundary crossing.
Legacy records get the configured uncertainty floor and remain identified as
`legacy_unaligned`; the migration cannot retroactively recover missing GPS fixes.

## Raw beam range and vessel attitude

Enable `attitudeCorrection` only for raw slant range on
`environment.depth.belowTransducer`. It defaults off for compatibility with
sounders that already compensate. The default beam mounting is straight down
when level. The boat owner confirmed this raw-range/downward convention for the
current installation. Do not apply cosine correction to an already corrected
below-surface/below-keel depth.

The implementation follows [Signal K attitude sign conventions](https://raw.githubusercontent.com/SignalK/specification/master/schemas/groups/navigation.json):
positive roll is starboard down, positive pitch is bow up. For a level-mounted
beam, the vertical component is `range * cos(roll) * cos(pitch)`. A full 3D rotation
also computes the horizontal beam-center offset; true heading rotates that offset
into north/east coordinates. COG and attitude yaw are not substituted for heading.

Fresh attitude and true heading are required (`attitudeMaxAgeSeconds`, default
0.5 s). Missing, stale, nonfinite, or near-horizontal geometry withholds mapped
soundings and reports a plugin error; original pings remain in the journal.
Roll/pitch over 60 degrees or a beam cone reaching the horizon are rejected.

A single-beam echo does **not** identify a precise ray within its beam cone.
The beam center is an estimate. `beamWidthDegrees` (full cone width, estimated
20 degrees until measured) adds horizontal footprint and vertical ambiguity to
the uncertainty budget. `attitudeSigmaDegrees` (default 2 degrees, estimated)
adds angle uncertainty. These assumptions should be replaced with the instrument's
specifications. NOAA describes the role of positioning and attitude in locating
soundings in its [survey equipment overview](https://nauticalcharts.noaa.gov/learn/hydrographic-survey-equipment.html).

Optional measured installation geometry lives in `recordingInstallation`:

- `beamMountRollDegrees`, `beamMountPitchDegrees`: mounting rotation, default 0.
- `antennaToTransducerForwardM`, `antennaToTransducerStarboardM`,
  `antennaToTransducerDownM`: GPS antenna to transducer vector.
- `transducerForwardM`, `transducerStarboardM`, `transducerDownM`: transducer
  relative to the boat's roll/pitch rotation origin.
- `offsetsVerified: true`: all six lever components must also be finite numbers.

Only verified complete lever geometry enables antenna-to-transducer position
correction and the change in transducer immersion caused by roll/pitch. Without
it, only beam angle/footprint correction runs and `geometry.leversVerified` is
false. Unknown lever offsets remain an uncorrected source of systematic error;
the uncertainty figures are conditional on the installation assumptions.
`surfaceToTransducerM` remains the level-waterline vertical offset. Heave and
sound-speed corrections are not added by this change.

Raw range remains raw in storage. Derived datum depth uses the vertical range,
attitude-adjusted immersion when available, and contemporaneous tide. Stationary
aggregation preserves geometry uncertainty rather than averaging it away.
The raw journal's correction-on-read is still offset/tide only, not an attitude
reprocessing engine. Old mapped soundings are not retrospectively attitude-corrected.
Historical geometry can now be reconstructed from separately queried history
paths, subject to the coverage and timing checks described below.

## Reconstructing existing soundings from history

`POST /admin/rebuild-history` with `{}` starts a background reconstruction over
all remaining uncorrected mapped records. Optional ISO `from` and `to` fields
bound the selection (inclusive start, exclusive end). It requires administrator
access, enabled raw-beam correction, and one-second history resolution.
`GET /status` exposes `history.rebuild` progress, counts, and any failure.

The worker queries GPS, raw range, roll, pitch, true heading, speed, course and
tide separately in bounded six-hour chunks with three queries in flight. It asks
for **first** values and refuses a provider that substitutes averages. History
bucket times still differ from instrument observation times: the reconstruction
retains the GNSS floor, adds speed times bucket/alignment interval to horizontal
uncertainty and a declared 0.15 m/s temporal allowance to vertical uncertainty.
This allowance is an estimate, not a measured seafloor slope. True heading is
never linearly averaged through its 0/360-degree discontinuity.

A stationary replacement needs at least the configured minimum samples and 80%
of the original accepted sample count (capped by the available one-second
buckets), coverage near both window ends, and no gap longer than five seconds.
Original records without adequate coverage, correct reference/datum/station,
or a known vertical offset remain active and count as skipped. The original
observation time, window, independent visit ID, and stored vertical offset are
retained. The configured mounting/installation geometry is assumed unchanged;
this cannot recover unknown historical installation changes.

Replacement is atomic per chunk. Original evidence stays in `raw_soundings`;
`sounding_replacements` links each original to its reconstructed successor.
Only `active_soundings` contributes to the API, statistics, QC and map cells.
Both old and new cells are rebuilt, removing a vacated old cell. A retry processes
only originals still active, so interrupted runs can resume without duplicate
contributions. Already attitude-corrected live observations are not replaced.
`store.supersededSoundings` reports the retained audit records.

Ordinary `/admin/backfill` now supports the same geometry for empty time ranges.
It refuses overlap with existing records when attitude correction is enabled;
use `/admin/rebuild-history` for those ranges. Automatic empty-store backfill is
available again. The raw journal remains unchanged by either operation.
