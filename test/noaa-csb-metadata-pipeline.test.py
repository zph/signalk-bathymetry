import gzip
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
