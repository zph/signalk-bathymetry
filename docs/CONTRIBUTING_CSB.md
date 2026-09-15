# Raw recording and NOAA contributions

## Recording from this deployment onward

`raw-observations.sqlite` is a separate SQLite WAL journal with full synchronous
commits. Each delivered finite depth update is recorded before tide requirements,
movement sampling, or stationary aggregation. No tide is required to record.
The journal retains original depth/reference/source, observation and receipt
times, timestamp provenance, GPS position/time/source, contemporaneous tide
height/datum/station/source/time/staleness, configured vertical offset, and an
installation metadata snapshot. Invalid-range or unmatched observations remain
in the journal with quality reasons and are excluded from review exports.

In Plugin Config, fill in **Raw recording: vessel and sensor installation**.
Measure the waterline-to-transducer offset in metres and update
`surfaceToTransducerM`; mark offsets verified only after measurement. Record
sounder/GNSS models, antenna-to-transducer forward and starboard offsets,
position reference, any instrument-applied corrections, and calibration notes.
Empty information remains unknown. Offsets and tide datum/station are configured
information, not independently verified instrument metadata. The existing tide
provider is treated as predicted; this assumption is retained in provenance.

The recording read endpoint calculates:

    correctedDepthM = rawDepthM + capturedSurfaceOffsetM - capturedTideHeightM

It returns null when the captured tide is absent/stale or the observation has
quality failures. It uses the tide at capture, not today's tide. Raw GeoJSON
exports never substitute corrected depth. Configuration changes affect new
observations, not historical installation snapshots.

Existing `bathymetry.sqlite` and chart surface caches remain intact. Their
stationary windows cannot be reconstructed into original pings, and historical
missing measurements cannot be recovered. This is a forward migration: the new
journal begins at deployment, and old chart evidence is not relabeled as raw.
Chart cells remain derived caches with the existing reprocess operation. The
new raw-record read API performs its own depth correction on demand.

The journal has no automatic deletion. Monitor disk use and back it up using
SQLite's backup API (or stop Signal K before copying the database and WAL).
Do not copy only an active SQLite main file and omit its WAL.

## Review and opt-in

Open **Local Bathymetry → Raw recording and sharing**, while signed in to
Signal K as administrator. Download a review sample without enabling sharing.
The sample is a GeoJSON FeatureCollection for onboarding review, not a claim
of validated NOAA submission metadata. It has a stable local vessel UUID.
The receiving node assigns/agrees the official provider-prefixed identifier.

Publication starts disabled. Enabling it requires an explicit CC0 choice.
Anonymous IDs do not hide visited locations. This release does not send data
over the network: the owner reviews and manually hands off exported files.
No NOAA credentials are required for local recording or sample preparation.

The export queue advances by immutable record ID, not measurement time, so
late-arriving records are not missed. Prepare returns the same pending batch
across retries/restarts. Advance only after confirmed partner receipt; repeat
acknowledgements are idempotent. Revoking consent blocks preparation and
acknowledgement, while local recording continues. Acknowledgement does not
delete the journal. Batches include scanned/excluded counts; inspect exclusions
before confirming a batch, especially when it has no valid features.

Administrator-only JSON POST endpoints under
`/plugins/signalk-bathymetry/admin/recording/`:

| Endpoint | Body | Result |
|---|---|---|
| `status` | `{}` | Counts, time extent, UUID, consent, cursor, capture error |
| `read` | `{"afterId":0,"limit":1000}` | Raw records and depth correction on read |
| `sample` | `{"afterId":0,"limit":1000}` | Local GeoJSON review sample; no cursor mutation |
| `consent` | `{"enabled":true,"license":"CC0-1.0"}` | Explicit publication opt-in; false revokes |
| `prepare` | `{"limit":1000}` | Durable batch ID and sample; consent required |
| `acknowledge` | `{"batchId":"…","receivedByPartner":true}` | Advance confirmed receipt cursor |

Limits are 1–10,000 scanned records. Use the returned `throughId` to page review
samples. All records from the new journal are available for review; enabling
permission does not itself select or publish historical tracks.

## Join a Trusted Node / onboard directly

1. Generate a sample after a day of recording, preferably including an underway
   trip. Review valid sounding count, time/GPS matching and installation data.
2. Contact **bathydata@iho.int**. Ask to contribute through an existing Trusted
   Node, or to discuss onboarding as an individual contributor/Trusted Node.
3. Describe Signal K, the sounder and GNSS, depth reference, measured offsets,
   cruising region, expected volume, and intended CC0 sharing. Provide the sample
   once you are comfortable sharing the included track.
4. Agree the format and provider prefix/UUID with the receiver. Map the sample
   metadata to the agreed CSB schema; split files if sensor/reference metadata
   changes. Run the receiver's validator before production submission.
5. For direct DCDB uploads, DCDB reviews an example and identifier before
   issuing an authentication token. Ask for current test/production endpoints.
   Do not assume an example `/test/` URL publishes to the production archive.
6. Keep the submitted file and confirmation/submission ID, then acknowledge
   the local batch. If submission failed or receipt is uncertain, retain it and
   retry the same batch rather than advancing.

Suggested first email (not sent automatically):

> Subject: Signal K crowdsourced bathymetry contribution onboarding
>
> I operate a vessel with a GNSS and depth sounder connected to Signal K and
> would like to contribute raw soundings to DCDB. My logger retains UTC time,
> position, raw depth/reference, sensor sources and installation metadata;
> tidal corrections are separate. Could you advise on an appropriate existing
> Trusted Node, or the process for direct contributor onboarding? I can provide
> a sample file and equipment/offset information for review. Please confirm
> the accepted schema, provider identifier, and submission process.

Sources checked 2026-09-15:

- [NOAA DCDB contribution and sample format links](https://www.ncei.noaa.gov/iho-data-centre-digital-bathymetry)
- [NOAA submission guidance v2.0](https://www.ncei.noaa.gov/sites/default/files/2025-07/Guidance%20for%20Submitting%20CSB%20Data%20to%20the%20IHODCDB_v2.0%20%283%29.pdf)
- [IHO B-12 edition 3.0](https://iho.int/uploads/user/pubs/bathy/B_12_CSB-Guidance_Document-Edition_3.0.0_Final.pdf)
- [CSB schema and validator](https://github.com/CI-CMG/csbschema)
