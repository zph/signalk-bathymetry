import gzip
import importlib.util
import json
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = (
    Path(__file__).parents[1] / "tools" / "noaa-csb-metadata" / "pipeline.py"
)
SPEC = importlib.util.spec_from_file_location("noaa_csb_metadata_pipeline", MODULE_PATH)
PIPELINE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(PIPELINE)


class MetadataNormalizationTest(unittest.TestCase):
    def test_full_metadata_is_cross_referenced_and_datum_corrected(self):
        item = {
            "traceId": "00000e9a-a9f7-4f59-a111-1ddfd02907d9",
            "fileName": "20250624171837822238_boat.tar.gz",
            "lastUpdated": "2026-07-04T15:47:41Z",
            "startTime": "2025-06-24T17:18:37Z",
            "otherLocations": {
                "s3": "s3://bucket/csb/csv/2025/06/24/20250624171837822238_boat_pointData.csv"
            },
            "metadata": {
                "crs": {"vertical": "ChartDatum"},
                "platform": {
                    "sensors": [{"type": "Sounder", "draft": 0.7}],
                    "correctors": {
                        "draftApplied": True,
                        "soundSpeedDocumented": True,
                        "positionOffsetsDocumented": True,
                    },
                },
                "processing": [
                    {
                        "type": "VerticalReduction",
                        "reference": "ChartDatum",
                        "method": "ModelledWL",
                        "model": "FES2022",
                    }
                ],
            },
        }
        row = PIPELINE.normalize_record(item, "2026-09-15T00:00:00Z")
        self.assertEqual(row["file_uuid"], "20250624171837822238_boat")
        self.assertEqual(row["collection_year"], 2025)
        self.assertEqual(row["depth_reference"], "chart_datum")
        self.assertEqual(row["qualification"], "datum_corrected")
        self.assertTrue(row["eligible_for_direct_fusion"])
        self.assertEqual(row["vertical_reduction_model"], "FES2022")

    def test_transducer_depth_with_unapplied_draft_is_correctable(self):
        item = {
            "traceId": "trace",
            "fileName": "20240101_boat.tar.gz",
            "startTime": 1704067200000,
            "metadata": {
                "crs": {"vertical": "Transducer"},
                "properties": {
                    "platform": {
                        "sensors": [{"type": "Sounder", "draft": 0.55}],
                        "correctors": {"draftApplied": False},
                    }
                },
            },
        }
        row = PIPELINE.normalize_record(item, "2026-09-15T00:00:00Z")
        self.assertEqual(row["qualification"], "datum_correctable")
        self.assertAlmostEqual(row["sounder_draft_m"], 0.55)
        self.assertFalse(row["eligible_for_direct_fusion"])

    def test_flat_noaa_metadata_remains_raw_unknown(self):
        item = {
            "traceId": "trace",
            "fileName": "20200328080252207395_boat.tar.gz",
            "metadata": {"dataProcessed": False, "platform": {"uniqueID": "boat"}},
        }
        row = PIPELINE.normalize_record(item, "2026-09-15T00:00:00Z")
        self.assertEqual(row["qualification"], "raw_unknown")
        self.assertFalse(row["eligible_for_direct_fusion"])

    def test_s3_object_name_produces_crowbar_join_key(self):
        document = PIPELINE.ET.fromstring(
            """<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
              <Contents>
                <Key>csb/csv/2025/01/01/20250101_boat_pointData.csv</Key>
                <LastModified>2026-09-01T01:02:03.000Z</LastModified>
                <ETag>&quot;abcdef&quot;</ETag><Size>1234</Size><StorageClass>STANDARD</StorageClass>
              </Contents>
            </ListBucketResult>"""
        )
        row = PIPELINE.normalize_s3_object(
            PIPELINE.xml_children(document, "Contents")[0]
        )
        self.assertEqual(row["file_uuid"], "20250101_boat")
        self.assertEqual(row["collection_year"], 2025)
        self.assertEqual(row["size"], 1234)
        self.assertEqual(row["etag"], "abcdef")

    def test_operational_lookup_indexes_pages_and_keeps_latest_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / "page-0000001.jsonl.gz"
            older = PIPELINE.normalize_record(
                {
                    "traceId": "trace-1",
                    "fileName": "20250101_boat.tar.gz",
                    "lastUpdated": "2026-01-01T00:00:00Z",
                    "metadata": {"crs": {"vertical": "Waterline"}},
                },
                "2026-09-15T00:00:00Z",
            )
            with gzip.open(page, "wt", encoding="utf-8") as handle:
                handle.write(json.dumps(older) + "\n")
            index = PIPELINE.MetadataLookupIndex(root / "metadata-lookup.sqlite")
            self.assertEqual(index.index_page("run-1", 1, page), 1)
            self.assertEqual(index.index_page("run-1", 1, page), 0)

            newer = {**older, "last_updated": "2026-02-01T00:00:00Z",
                     "qualification": "datum_corrected",
                     "eligible_for_direct_fusion": True}
            page2 = root / "page-0000002.jsonl.gz"
            with gzip.open(page2, "wt", encoding="utf-8") as handle:
                handle.write(json.dumps(newer) + "\n")
            index.index_page("run-2", 1, page2)
            with sqlite3.connect(index.path) as connection:
                row = connection.execute(
                    "SELECT qualification,eligible_for_direct_fusion FROM metadata_records "
                    "WHERE file_name=?", ("20250101_boat.tar.gz",)
                ).fetchone()
            self.assertEqual(row, ("datum_corrected", 1))


class ParquetBuildTest(unittest.TestCase):
    def test_build_and_join_preserve_metadata_as_keyed_catalog(self):
        try:
            import duckdb
        except ImportError:
            self.skipTest("duckdb is not installed")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "mirror"
            run = root / "runs" / "run-1"
            pages = run / "pages"
            pages.mkdir(parents=True)
            rows = [
                PIPELINE.normalize_record(
                    {
                        "traceId": "trace-1",
                        "fileName": "20250101_boat.tar.gz",
                        "lastUpdated": "2026-01-01T00:00:00Z",
                        "startTime": "2025-01-01T00:00:00Z",
                        "metadata": {"crs": {"vertical": "Waterline"}},
                    },
                    "2026-09-15T00:00:00Z",
                )
            ]
            with gzip.open(pages / "page-0000001.jsonl.gz", "wt", encoding="utf-8") as handle:
                for row in rows:
                    handle.write(json.dumps(row) + "\n")
            (run / "manifest.json").write_text(
                json.dumps({"complete": True, "downloaded_pages": 1}), encoding="utf-8"
            )
            s3_run = root / "s3-runs" / "run-1"
            s3_pages = s3_run / "pages"
            s3_pages.mkdir(parents=True)
            s3_rows = [
                {
                    "schema_version": 1,
                    "key": "csb/csv/2025/01/01/20250101_boat_pointData.csv",
                    "s3_uri": "s3://noaa-dcdb-bathymetry-pds/csb/csv/2025/01/01/20250101_boat_pointData.csv",
                    "file_uuid": "20250101_boat",
                    "size": 1234,
                    "last_modified": "2026-09-01T00:00:00Z",
                    "etag": "etag",
                    "storage_class": "STANDARD",
                    "collection_year": 2025,
                },
                {
                    "schema_version": 1,
                    "key": "csb/csv/2024/01/01/20240101_missing_pointData.csv",
                    "s3_uri": "s3://noaa-dcdb-bathymetry-pds/csb/csv/2024/01/01/20240101_missing_pointData.csv",
                    "file_uuid": "20240101_missing",
                    "size": 456,
                    "last_modified": "2026-09-01T00:00:00Z",
                    "etag": "etag2",
                    "storage_class": "STANDARD",
                    "collection_year": 2024,
                },
            ]
            with gzip.open(s3_pages / "page-0000001.jsonl.gz", "wt", encoding="utf-8") as handle:
                for row in s3_rows:
                    handle.write(json.dumps(row) + "\n")
            (s3_run / "manifest.json").write_text(
                json.dumps(
                    {
                        "complete": True,
                        "completed_at": "2026-09-15T00:00:00Z",
                        "downloaded_pages": 1,
                    }
                ),
                encoding="utf-8",
            )
            metadata_output = Path(directory) / "metadata"
            manifest = PIPELINE.build_parquet(root, metadata_output)
            self.assertEqual(manifest["file_index_records"], 1)
            self.assertEqual(manifest["s3_objects"], 2)
            self.assertEqual(
                manifest["s3_reconciliation_counts"],
                {"matched": 1, "s3_without_metadata": 1},
            )

            soundings = Path(directory) / "soundings.parquet"
            connection = duckdb.connect()
            connection.execute(
                "COPY (SELECT '20250101_boat' file_uuid, 12.3 depth_m) TO ? (FORMAT PARQUET)",
                [str(soundings)],
            )
            connection.close()
            joined = Path(directory) / "joined"
            join_manifest = PIPELINE.join_soundings(
                metadata_output, str(soundings), joined
            )
            self.assertEqual(join_manifest["matched_soundings"], 1)
            result = duckdb.connect().execute(
                "SELECT csb_metadata_qualification FROM read_parquet(?)",
                [str(joined / "enriched.parquet")],
            ).fetchone()
            self.assertEqual(result[0], "datum_correctable")

    def test_sharded_inventory_is_combined_for_build_and_mirror(self):
        try:
            import duckdb
        except ImportError:
            self.skipTest("duckdb is not installed")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "inventory"
            source_files = Path(directory) / "sources"
            source_files.mkdir()
            shards = []
            source_by_key = {}
            for year in (2024, 2025):
                shard_root = root / "s3-shards" / f"{year}-test"
                run = shard_root / "s3-runs" / "run-1"
                pages = run / "pages"
                pages.mkdir(parents=True)
                key = f"csb/csv/{year}/01/01/{year}0101_boat_pointData.csv"
                source = source_files / f"{year}.csv"
                source.write_text(
                    "UNIQUE_ID,FILE_UUID,LON,LAT,DEPTH,TIME,PLATFORM_NAME,PROVIDER\n"
                    f"boat,{year}0101_boat,-122.1,37.2,4.56,{year}-01-01T00:00:00Z,TEST,unit\n",
                    encoding="utf-8",
                )
                source_by_key[key] = source
                row = {
                    "schema_version": 1,
                    "key": key,
                    "s3_uri": f"s3://bucket/{key}",
                    "file_uuid": f"{year}0101_boat",
                    "size": source.stat().st_size,
                    "last_modified": "2026-09-01T00:00:00Z",
                    "etag": None,
                    "storage_class": "STANDARD",
                    "collection_year": year,
                }
                with gzip.open(
                    pages / "page-0000001.jsonl.gz", "wt", encoding="utf-8"
                ) as handle:
                    handle.write(json.dumps(row) + "\n")
                (run / "manifest.json").write_text(
                    json.dumps(
                        {
                            "complete": True,
                            "completed_at": "2026-09-15T00:00:00Z",
                            "downloaded_pages": 1,
                            "downloaded_objects": 1,
                        }
                    ),
                    encoding="utf-8",
                )
                shards.append(
                    {
                        "prefix": f"csb/csv/{year}/",
                        "root": f"s3-shards/{year}-test",
                        "manifest": {"complete": True},
                    }
                )
            (root / "s3-shards-manifest.json").write_text(
                json.dumps({"complete": True, "shards": shards}), encoding="utf-8"
            )
            self.assertEqual(len(PIPELINE.latest_completed_s3_page_files(root)), 2)

            def fake_download(row, destination, *_args, **_kwargs):
                source = source_by_key[row["key"]]
                shutil.copyfile(source, destination)
                return {
                    "local_path": str(destination),
                    "key": row["key"],
                    "etag": row["etag"],
                    "last_modified": row["last_modified"],
                    "size": source.stat().st_size,
                    "source_sha256": PIPELINE.sha256_file(source),
                }

            output = Path(directory) / "soundings"
            with mock.patch.object(PIPELINE, "download_s3_object", fake_download):
                manifest = PIPELINE.mirror_soundings(
                    root,
                    output,
                    workers=2,
                    target_pack_bytes=1,
                    max_pack_objects=1,
                    min_free_bytes=0,
                )
            self.assertTrue(manifest["complete"])
            self.assertEqual(manifest["source_objects"], 2)
            self.assertEqual(manifest["soundings"], 2)
            values = duckdb.connect().execute(
                "SELECT file_uuid, depth FROM read_parquet(?) ORDER BY file_uuid",
                [str(output / "soundings" / "**" / "*.parquet")],
            ).fetchall()
            self.assertEqual(
                values,
                [("20240101_boat", "4.56"), ("20250101_boat", "4.56")],
            )

    def test_incremental_build_replaces_only_affected_year_partition(self):
        try:
            import duckdb
        except ImportError:
            self.skipTest("duckdb is not installed")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "mirror"
            output = Path(directory) / "parquet"

            def write_run(run_id, rows):
                pages = root / "runs" / run_id / "pages"
                pages.mkdir(parents=True)
                with gzip.open(pages / "page-0000001.jsonl.gz", "wt", encoding="utf-8") as handle:
                    for row in rows:
                        handle.write(json.dumps(row) + "\n")
                (pages.parent / "manifest.json").write_text(json.dumps({
                    "complete": True, "downloaded_pages": 1,
                    "downloaded_records": len(rows)
                }))

            baseline = [
                PIPELINE.normalize_record({
                    "traceId": "trace-2024", "fileName": "20240101_boat.tar.gz",
                    "lastUpdated": "2026-01-01T00:00:00Z", "startTime": "2024-01-01T00:00:00Z",
                    "metadata": {}
                }, "2026-01-01T00:00:00Z"),
                PIPELINE.normalize_record({
                    "traceId": "trace-2025", "fileName": "20250101_boat.tar.gz",
                    "lastUpdated": "2026-01-01T00:00:00Z", "startTime": "2025-01-01T00:00:00Z",
                    "metadata": {}
                }, "2026-01-01T00:00:00Z"),
            ]
            write_run("baseline", baseline)
            first = PIPELINE.build_parquet(root, output)
            untouched = next((output / "records" / "collection_year=2024").glob("*.parquet"))
            untouched_inode = untouched.stat().st_ino

            changed = PIPELINE.normalize_record({
                "traceId": "trace-2025", "fileName": "20250101_boat.tar.gz",
                "lastUpdated": "2026-09-15T00:00:00Z", "startTime": "2025-01-01T00:00:00Z",
                "metadata": {"crs": {"vertical": "Waterline"}}
            }, "2026-09-15T00:00:00Z")
            write_run("delta", [changed])
            second = PIPELINE.build_parquet(root, output, incremental_run_id="delta")

            self.assertEqual(first["build_mode"], "full")
            self.assertEqual(second["build_mode"], "incremental")
            self.assertEqual(second["affected_years"], [2025])
            self.assertEqual(untouched.stat().st_ino, untouched_inode)
            qualification = duckdb.connect().execute(
                "SELECT qualification FROM read_parquet(?) WHERE trace_id='trace-2025'",
                [str(output / "records" / "**" / "*.parquet")],
            ).fetchone()[0]
            self.assertEqual(qualification, "datum_correctable")
            self.assertEqual(second["current_trace_records"], 2)


class IncrementalDaemonTest(unittest.TestCase):
    def test_sync_writes_dashboard_progress_and_advances_watermark(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def page(_url, number, *_args):
                return {
                    "page": number,
                    "totalPages": 2,
                    "totalItems": 2,
                    "items": [{
                        "traceId": f"trace-{number}",
                        "fileName": f"2026010{number}_boat.tar.gz",
                        "metadata": {},
                    }],
                }

            with mock.patch.object(PIPELINE, "fetch_page", side_effect=page):
                manifest = PIPELINE.sync_metadata(root, workers=2)
            status = json.loads((root / "status.json").read_text())
            state = json.loads((root / "state.json").read_text())
            self.assertTrue(manifest["complete"])
            self.assertEqual(status["stage"], "metadata_sync_complete")
            self.assertEqual(status["completed_pages"], 2)
            self.assertEqual(status["total_pages"], 2)
            self.assertEqual(state["last_successful_cutoff"], manifest["cutoff"])
            self.assertIsNone(state["in_progress"])

    def test_daemon_publishes_completed_build_before_sleep(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "mirror"
            output = Path(directory) / "parquet"
            args = PIPELINE.parse_args([
                "daemon", "--root", str(root), "--output", str(output),
                "--interval-seconds", "60"
            ])
            sync = {
                "run_id": "run", "cutoff": "2026-09-15T00:00:00Z",
                "lower_bound": None, "reported_total_items": 10,
                "reported_total_pages": 1, "downloaded_pages": 1,
            }
            build = {"current_trace_records": 9, "file_index_records": 8}
            with mock.patch.object(PIPELINE, "sync_metadata", return_value=sync), \
                    mock.patch.object(PIPELINE, "build_parquet", return_value=build), \
                    mock.patch.object(PIPELINE.time, "sleep", side_effect=KeyboardInterrupt):
                PIPELINE.run_daemon(args)
            status = json.loads((root / "status.json").read_text())
            self.assertEqual(status["stage"], "idle")
            self.assertEqual(status["metadata_records"], 9)
            self.assertEqual(status["file_index_records"], 8)
            self.assertIn("next_run_at", status)


if __name__ == "__main__":
    unittest.main()
