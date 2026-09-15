# NOAA CSB metadata mirror and Parquet catalog

This offline tool downloads the complete public NOAA Crowbar metadata catalog,
inventories the corresponding public S3 sounding objects, keeps immutable
compressed source snapshots, normalizes the fields needed for depth-reference
qualification, and writes partitioned Parquet catalogs.

NOAA intentionally publishes these as separate surfaces. The public NODD bucket
contains `csb/csv/` sounding objects; its CSB CSV rows contain the sounding and
identity fields but not the full submitted metadata. Crowbar is the metadata
index and includes each record's S3 location. The shared key is the S3 filename
stem (`*_pointData.csv`) and the CSV `FILE_UUID`. The pipeline preserves that
separation and reports missing joins rather than inventing metadata.

It is intentionally not part of the Signal K plugin process. NOAA currently
publishes roughly one million metadata records, so a global crawl belongs in a
resumable batch job on `home-server` or another archival host.

## Outputs

The mirror directory contains immutable `runs/<cutoff>/pages/*.jsonl.gz` files.
Each line retains the complete Crowbar response record as `raw_record_json`, the
complete submitted metadata as `metadata_json`, and normalized lookup fields.
`state.json` contains the successful update watermark and any resumable run.

The Parquet output contains:

- `records/collection_year=YYYY/*.parquet`: one latest row per Crowbar
  `trace_id`, retaining every distinct metadata record.
- `file-index/collection_year=YYYY/*.parquet`: one deterministic current row
  per sounding `FILE_UUID`, with a candidate count when NOAA has collisions.
- `s3-objects/collection_year=YYYY/*.parquet`: the latest complete inventory
  of objects below the public `csb/csv/` prefix.
- `s3-reconciliation/collection_year=YYYY/*.parquet`: a full outer
  reconciliation classified as `matched`, `s3_without_metadata`, or
  `metadata_without_s3`.
- `manifest.json`: source counts and qualification counts.

The join key is derived from NOAA's S3 `_pointData.csv` object name. It matches
the `FILE_UUID` column inside that sounding file. Metadata is stored once in the
file catalog rather than repeating large JSON documents for every sounding.

Qualification values are deliberately conservative:

- `datum_corrected`: an explicit chart/ellipsoid reduction and method are
  documented; the only class eligible for direct fusion.
- `datum_correctable`: the water-surface depth can be resolved and timestamped,
  but a water-level/datum reduction must still be performed.
- `surface_resolved`: sensor reference is resolvable but time is missing.
- `reference_known`: a reference exists but required offsets/state are missing.
- `raw_unknown`: the depth reference is absent.

The raw metadata remains authoritative. Normalized qualification can be rebuilt
when NOAA schemas or our policy evolve.

The home-server deployment does not use this tool's optional sounding mirror.
Its `noaa-csb-metadata` stage shares the existing NOAA archive data root, fetches
only Crowbar metadata, and joins that metadata to the soundings already managed
by `noaa-csb-archive`.

## Run locally

Python 3.11+ and DuckDB are required for Parquet materialization. Metadata sync
uses only the Python standard library.

```sh
python tools/noaa-csb-metadata/pipeline.py sync \
  --root /data/noaa-csb-metadata/mirror --workers 4

python tools/noaa-csb-metadata/pipeline.py sync-s3 \
  --root /data/noaa-csb-metadata/mirror

python tools/noaa-csb-metadata/pipeline.py sync-s3-sharded \
  --root /data/noaa-csb-metadata/mirror --workers 6

python tools/noaa-csb-metadata/pipeline.py build \
  --root /data/noaa-csb-metadata/mirror \
  --output /data/noaa-csb-metadata/parquet

python tools/noaa-csb-metadata/pipeline.py daemon \
  --root /data/noaa-csb-archive/crowbar/mirror \
  --output /data/noaa-csb-archive/crowbar/parquet \
  --workers 16 --interval-seconds 86400
```

The first command freezes an upper `lastUpdated` cutoff, downloads pages in
stable `traceId` order, retries transient failures, and resumes an interrupted
run. A completed run advances the incremental watermark. `--full` starts a new
full reconciliation. `--max-pages` exists for testing and never advances the
watermark unless it happens to cover the whole response.

`daemon` runs that same resumable sync, atomically rebuilds the metadata Parquet
catalog, then sleeps until the next incremental cycle. It writes `status.json`
throughout the sync so the archive dashboard can show stage, progress, rate, ETA,
watermark, and next run. The first successful baseline is the only full Crowbar
scan; later cycles request records changed since the stored cutoff.

The S3 crawl uses unauthenticated `ListObjectsV2`, follows continuation tokens,
and checkpoints every 1,000-object page. `sync-s3-sharded` first discovers the
published year prefixes, then inventories those nonoverlapping prefixes in
parallel. The combined manifest records the exact object count and source byte
total. Rerunning resumes partial shards and reuses completed shards; pass
`--refresh` to take a new snapshot. `run --inventory-s3` retains the slower
single-prefix mode for simple scheduled refreshes.

## Archive all published soundings

After a complete S3 inventory, create the lossless compressed sounding archive:

```sh
python tools/noaa-csb-metadata/pipeline.py mirror-soundings \
  --inventory-root /data/noaa-csb-metadata/mirror \
  --output /data/noaa-csb-metadata/soundings \
  --workers 4
```

This downloader is resumable at the pack level. It verifies every download
against the published byte size and verifies single-part S3 ETags as MD5. Each
Parquet pack has a SHA-256 sidecar. The archive retains the exact text value of
all eight published CSV columns plus the source object key, ETag, modification
time, size, and SHA-256. No coordinate, depth, or timestamp value is rounded.

Packs target 256 MiB of source CSV and at most 250 source objects. A 50 GiB free
space reserve is enforced by default. For a storage benchmark before a global
run, use `--max-raw-bytes 1073741824`; a limited run is marked incomplete in
its manifest. Production and benchmark outputs should use different output
directories.

To attach the compact qualification fields to an existing sounding dataset:

```sh
python tools/noaa-csb-metadata/pipeline.py join \
  --metadata /data/noaa-csb-metadata/parquet \
  --soundings-glob '/data/csb/soundings/**/*.parquet' \
  --output /data/csb/enriched
```

The sounding input must contain `file_uuid`. The enriched output preserves all
sounding columns and adds `csb_metadata_*` columns. Full source metadata stays
in the keyed metadata catalog.

## Run with Podman Compose

```sh
cd tools/noaa-csb-metadata
NOAA_CSB_DATA_DIR=/srv/noaa-csb-metadata podman compose run --rm noaa-csb-inventory
NOAA_CSB_DATA_DIR=/srv/noaa-csb-metadata podman compose run --rm noaa-csb-metadata
NOAA_CSB_DATA_DIR=/srv/noaa-csb-metadata podman compose run --rm noaa-csb-soundings
```

The inventory job records the exact public object count and source size. The
metadata job performs an incremental Crowbar sync and atomically replaces the
derived catalog. The soundings job downloads and packs all inventoried CSVs.
Interrupted work remains resumable, and successful packs are checksum-verified
before reuse.
