#!/usr/bin/env python3
"""Mirror NOAA Crowbar CSB metadata and materialize cross-referenced Parquet.

The downloader is deliberately separate from the Signal K runtime. A complete
metadata crawl is large and slow, while the resulting Parquet catalog is a
stable offline input for archive and qualification jobs.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import gzip
import hashlib
import json
import os
import random
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


DEFAULT_API_URL = (
    "https://www.ngdc.noaa.gov/ingest-external/"
    "index-service/api/v1/csb/index"
)
SCHEMA_VERSION = 1
ITEMS_PER_PAGE = 200
DEFAULT_S3_LIST_URL = "https://noaa-dcdb-bathymetry-pds.s3.amazonaws.com/"
DEFAULT_S3_PREFIX = "csb/csv/"
S3_PAGE_SIZE = 1000
METADATA_COLUMN_TYPES = {
    "schema_version": "BIGINT", "mirrored_at": "VARCHAR", "trace_id": "VARCHAR",
    "file_uuid": "VARCHAR", "file_name": "VARCHAR", "s3_uri": "VARCHAR",
    "external_id": "VARCHAR", "provider": "VARCHAR", "platform": "VARCHAR",
    "instrument": "VARCHAR", "publish": "BOOLEAN", "file_size": "DOUBLE",
    "start_time": "VARCHAR", "end_time": "VARCHAR", "created": "VARCHAR",
    "reviewed": "VARCHAR", "last_updated": "VARCHAR", "data_license": "VARCHAR",
    "collection_year": "BIGINT", "depth_reference": "VARCHAR",
    "sounder_draft_m": "DOUBLE", "draft_applied": "BOOLEAN",
    "sound_speed_documented": "BOOLEAN", "position_offsets_documented": "BOOLEAN",
    "motion_offsets_applied": "BOOLEAN", "data_processed": "BOOLEAN",
    "vertical_reduction_reference": "VARCHAR", "vertical_reduction_method": "VARCHAR",
    "vertical_reduction_model": "VARCHAR", "qualification": "VARCHAR",
    "eligible_for_direct_fusion": "BOOLEAN", "qualification_reasons_json": "VARCHAR",
    "geometry_json": "VARCHAR", "metadata_json": "VARCHAR",
    "other_locations_json": "VARCHAR", "raw_record_json": "VARCHAR",
}


def metadata_columns_sql() -> str:
    return "{" + ",".join(f"{name}: '{kind}'" for name, kind in METADATA_COLUMN_TYPES.items()) + "}"


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_z(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Mirror NOAA CSB metadata and build Parquet catalogs"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_sync_arguments(command: argparse.ArgumentParser) -> None:
        command.add_argument("--root", type=Path, required=True)
        command.add_argument("--api-url", default=DEFAULT_API_URL)
        command.add_argument("--workers", type=int, default=4)
        command.add_argument("--max-pages", type=int)
        command.add_argument("--full", action="store_true")
        command.add_argument("--timeout-seconds", type=float, default=60)
        command.add_argument("--retries", type=int, default=6)

    sync = subparsers.add_parser("sync", help="download/resume Crowbar metadata")
    add_sync_arguments(sync)

    sync_s3 = subparsers.add_parser(
        "sync-s3", help="inventory/resume NOAA's public CSB S3 objects"
    )
    sync_s3.add_argument("--root", type=Path, required=True)
    sync_s3.add_argument("--list-url", default=DEFAULT_S3_LIST_URL)
    sync_s3.add_argument("--prefix", default=DEFAULT_S3_PREFIX)
    sync_s3.add_argument("--max-pages", type=int)
    sync_s3.add_argument("--timeout-seconds", type=float, default=60)
    sync_s3.add_argument("--retries", type=int, default=6)

    sync_s3_sharded = subparsers.add_parser(
        "sync-s3-sharded",
        help="inventory NOAA CSB S3 objects in parallel by published year prefix",
    )
    sync_s3_sharded.add_argument("--root", type=Path, required=True)
    sync_s3_sharded.add_argument("--list-url", default=DEFAULT_S3_LIST_URL)
    sync_s3_sharded.add_argument("--prefix", default=DEFAULT_S3_PREFIX)
    sync_s3_sharded.add_argument("--workers", type=int, default=6)
    sync_s3_sharded.add_argument("--max-pages", type=int)
    sync_s3_sharded.add_argument("--timeout-seconds", type=float, default=60)
    sync_s3_sharded.add_argument("--retries", type=int, default=6)
    sync_s3_sharded.add_argument(
        "--refresh",
        action="store_true",
        help="start a new inventory even when a complete shard inventory exists",
    )

    mirror_soundings = subparsers.add_parser(
        "mirror-soundings",
        help="download every inventoried CSB CSV into checksummed lossless Parquet packs",
    )
    mirror_soundings.add_argument("--inventory-root", type=Path, required=True)
    mirror_soundings.add_argument("--output", type=Path, required=True)
    mirror_soundings.add_argument("--list-url", default=DEFAULT_S3_LIST_URL)
    mirror_soundings.add_argument("--workers", type=int, default=4)
    mirror_soundings.add_argument(
        "--target-pack-bytes", type=int, default=256 * 1024 * 1024
    )
    mirror_soundings.add_argument("--max-pack-objects", type=int, default=250)
    mirror_soundings.add_argument("--max-objects", type=int)
    mirror_soundings.add_argument("--max-raw-bytes", type=int)
    mirror_soundings.add_argument(
        "--min-free-bytes",
        type=int,
        default=50 * 1024 * 1024 * 1024,
        help="stop before free storage falls below this reserve",
    )
    mirror_soundings.add_argument("--timeout-seconds", type=float, default=120)
    mirror_soundings.add_argument("--retries", type=int, default=6)

    build = subparsers.add_parser("build", help="build partitioned metadata Parquet")
    build.add_argument("--root", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--overwrite", action="store_true")
    build.add_argument("--incremental-run-id")
    build.add_argument("--force-full", action="store_true")

    join = subparsers.add_parser(
        "join", help="attach slim qualification columns to sounding Parquet"
    )
    join.add_argument("--metadata", type=Path, required=True)
    join.add_argument("--soundings-glob", required=True)
    join.add_argument("--output", type=Path, required=True)
    join.add_argument("--overwrite", action="store_true")

    run = subparsers.add_parser("run", help="sync then build metadata Parquet")
    add_sync_arguments(run)
    run.add_argument("--output", type=Path, required=True)
    run.add_argument("--overwrite", action="store_true")
    run.add_argument(
        "--inventory-s3",
        action="store_true",
        help="also crawl the public CSB CSV prefix before materializing",
    )
    run.add_argument("--s3-list-url", default=DEFAULT_S3_LIST_URL)
    run.add_argument("--s3-prefix", default=DEFAULT_S3_PREFIX)

    daemon = subparsers.add_parser(
        "daemon", help="continuously sync Crowbar metadata and rebuild its Parquet index"
    )
    add_sync_arguments(daemon)
    daemon.add_argument("--output", type=Path, required=True)
    daemon.add_argument("--interval-seconds", type=int, default=86400)
    daemon.add_argument("--full-rebuild-interval-seconds", type=int, default=2592000)

    return parser.parse_args(argv)


def atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    os.replace(temporary, path)


def read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object in {path}")
    return value


def run_id_for(cutoff: str) -> str:
    return cutoff.replace(":", "").replace("-", "").replace(".", "")


def request_url(
    api_url: str, page: int, cutoff: str, lower_bound: str | None
) -> str:
    parameters: list[tuple[str, str]] = [
        ("page", str(page)),
        ("itemsPerPage", str(ITEMS_PER_PAGE)),
        ("order", "traceId:asc"),
        ("dataset", "CSB"),
        ("lastUpdatedLt", cutoff),
    ]
    if lower_bound:
        parameters.append(("lastUpdatedGe", lower_bound))
    return f"{api_url}?{urllib.parse.urlencode(parameters)}"


def fetch_page(
    api_url: str,
    page: int,
    cutoff: str,
    lower_bound: str | None,
    timeout_seconds: float,
    retries: int,
) -> dict[str, Any]:
    url = request_url(api_url, page, cutoff, lower_bound)
    for attempt in range(retries + 1):
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "signalk-bathymetry-noaa-metadata/1",
                },
            )
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                payload = json.load(response)
            validate_page(payload, page)
            return payload
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as error:
            if attempt >= retries:
                raise RuntimeError(f"NOAA metadata page {page} failed: {error}") from error
            delay = min(60.0, 0.75 * (2**attempt)) + random.random() * 0.5
            time.sleep(delay)
    raise AssertionError("retry loop exhausted")


def validate_page(payload: Any, requested_page: int) -> None:
    if not isinstance(payload, dict):
        raise ValueError("NOAA response is not an object")
    if payload.get("page") != requested_page:
        raise ValueError(
            f"NOAA returned page {payload.get('page')!r} for request {requested_page}"
        )
    if not isinstance(payload.get("items"), list):
        raise ValueError("NOAA response omits items")
    if not isinstance(payload.get("totalPages"), int):
        raise ValueError("NOAA response omits totalPages")


def write_page(path: Path, payload: Mapping[str, Any], mirrored_at: str) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as raw_handle:
        temporary = Path(raw_handle.name)
    try:
        with temporary.open("wb") as raw_output:
            with gzip.GzipFile(fileobj=raw_output, mode="wb", compresslevel=6, mtime=0) as zipped:
                for item in payload["items"]:
                    normalized = normalize_record(item, mirrored_at)
                    zipped.write(
                        json.dumps(normalized, separators=(",", ":"), sort_keys=True).encode(
                            "utf-8"
                        )
                    )
                    zipped.write(b"\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return len(payload["items"])


def s3_request_url(list_url: str, prefix: str, continuation_token: str | None) -> str:
    parameters = {
        "list-type": "2",
        "prefix": prefix,
        "max-keys": str(S3_PAGE_SIZE),
    }
    if continuation_token:
        parameters["continuation-token"] = continuation_token
    separator = "&" if "?" in list_url else "?"
    return f"{list_url}{separator}{urllib.parse.urlencode(parameters)}"


def s3_prefix_request_url(list_url: str, prefix: str) -> str:
    parameters = {
        "list-type": "2",
        "prefix": prefix,
        "delimiter": "/",
        "max-keys": str(S3_PAGE_SIZE),
    }
    separator = "&" if "?" in list_url else "?"
    return f"{list_url}{separator}{urllib.parse.urlencode(parameters)}"


def discover_s3_prefixes(
    list_url: str,
    prefix: str,
    timeout_seconds: float,
    retries: int,
) -> list[str]:
    url = s3_prefix_request_url(list_url, prefix)
    for attempt in range(retries + 1):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "signalk-bathymetry-noaa-s3-inventory/1"},
            )
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                document = ET.parse(response).getroot()
            prefixes = [
                required_string(xml_text(node, "Prefix"), "S3 common prefix")
                for node in xml_children(document, "CommonPrefixes")
            ]
            if not prefixes:
                raise ValueError(f"S3 listing returned no child prefixes below {prefix}")
            return sorted(prefixes)
        except (urllib.error.URLError, TimeoutError, ET.ParseError, ValueError) as error:
            if attempt >= retries:
                raise RuntimeError(f"NOAA S3 prefix discovery failed: {error}") from error
            delay = min(60.0, 0.75 * (2**attempt)) + random.random() * 0.5
            time.sleep(delay)
    raise AssertionError("retry loop exhausted")


def fetch_s3_page(
    list_url: str,
    prefix: str,
    continuation_token: str | None,
    timeout_seconds: float,
    retries: int,
) -> tuple[list[dict[str, Any]], str | None]:
    url = s3_request_url(list_url, prefix, continuation_token)
    for attempt in range(retries + 1):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "signalk-bathymetry-noaa-s3-inventory/1"},
            )
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                document = ET.parse(response).getroot()
            rows = [normalize_s3_object(node) for node in xml_children(document, "Contents")]
            is_truncated = (xml_text(document, "IsTruncated") or "false").lower() == "true"
            next_token = xml_text(document, "NextContinuationToken")
            if is_truncated and not next_token:
                raise ValueError("truncated S3 listing omitted NextContinuationToken")
            return rows, next_token if is_truncated else None
        except (urllib.error.URLError, TimeoutError, ET.ParseError, ValueError) as error:
            if attempt >= retries:
                raise RuntimeError(f"NOAA S3 inventory page failed: {error}") from error
            delay = min(60.0, 0.75 * (2**attempt)) + random.random() * 0.5
            time.sleep(delay)
    raise AssertionError("retry loop exhausted")


def xml_children(node: ET.Element, local_name: str) -> list[ET.Element]:
    return [child for child in node if child.tag.rsplit("}", 1)[-1] == local_name]


def xml_text(node: ET.Element, local_name: str) -> str | None:
    for child in node:
        if child.tag.rsplit("}", 1)[-1] == local_name:
            return child.text
    return None


def normalize_s3_object(node: ET.Element) -> dict[str, Any]:
    key = required_string(xml_text(node, "Key"), "S3 object key")
    return {
        "schema_version": SCHEMA_VERSION,
        "key": key,
        "s3_uri": f"s3://noaa-dcdb-bathymetry-pds/{key}",
        "file_uuid": derive_file_uuid(None, key),
        "size": int(xml_text(node, "Size") or 0),
        "last_modified": xml_text(node, "LastModified"),
        "etag": (xml_text(node, "ETag") or "").strip('"') or None,
        "storage_class": xml_text(node, "StorageClass"),
        "collection_year": extract_year(key, None, None),
    }


def write_jsonl_page(path: Path, rows: Sequence[Mapping[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as raw_handle:
        temporary = Path(raw_handle.name)
    try:
        with temporary.open("wb") as raw_output:
            with gzip.GzipFile(fileobj=raw_output, mode="wb", compresslevel=6, mtime=0) as zipped:
                for row in rows:
                    zipped.write(
                        json.dumps(row, separators=(",", ":"), sort_keys=True).encode("utf-8")
                    )
                    zipped.write(b"\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return len(rows)


def sync_s3_inventory(
    root: Path,
    list_url: str = DEFAULT_S3_LIST_URL,
    prefix: str = DEFAULT_S3_PREFIX,
    max_pages: int | None = None,
    timeout_seconds: float = 60,
    retries: int = 6,
) -> dict[str, Any]:
    if max_pages is not None and max_pages < 1:
        raise ValueError("max_pages must be positive")
    root.mkdir(parents=True, exist_ok=True)
    state_path = root / "s3-state.json"
    state = read_json(state_path) if state_path.exists() else {}
    in_progress = state.get("in_progress")
    if isinstance(in_progress, dict):
        if in_progress.get("prefix") != prefix or in_progress.get("list_url") != list_url:
            raise RuntimeError(
                "an S3 inventory for a different URL/prefix is in progress; finish it or use another root"
            )
        run_id = required_string(in_progress.get("run_id"), "S3 run id")
        next_token = optional_string(in_progress.get("next_token"))
        page_number = int(in_progress.get("next_page", 1))
        object_count = int(in_progress.get("object_count", 0))
    else:
        started_at = iso_z(utc_now())
        run_id = run_id_for(started_at)
        next_token = None
        page_number = 1
        object_count = 0
        in_progress = {
            "run_id": run_id,
            "list_url": list_url,
            "prefix": prefix,
            "next_token": None,
            "next_page": page_number,
            "object_count": object_count,
            "started_at": started_at,
        }
        state["schema_version"] = SCHEMA_VERSION
        state["in_progress"] = in_progress
        atomic_json(state_path, state)

    run_dir = root / "s3-runs" / run_id
    pages_dir = run_dir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    pages_this_call = 0
    complete = False
    while max_pages is None or pages_this_call < max_pages:
        rows, following_token = fetch_s3_page(
            list_url, prefix, next_token, timeout_seconds, retries
        )
        path = page_path(pages_dir, page_number)
        if path.exists():
            raise RuntimeError(f"refusing to overwrite existing S3 inventory page {path}")
        object_count += write_jsonl_page(path, rows)
        pages_this_call += 1
        print(
            f"NOAA S3 inventory {run_id}: page {page_number}, {object_count} objects",
            flush=True,
        )
        if following_token is None:
            complete = True
            break
        next_token = following_token
        page_number += 1
        in_progress.update(
            {
                "next_token": next_token,
                "next_page": page_number,
                "object_count": object_count,
            }
        )
        state["in_progress"] = in_progress
        atomic_json(state_path, state)

    downloaded_pages = len(list(pages_dir.glob("page-*.jsonl.gz")))
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "list_url": list_url,
        "prefix": prefix,
        "downloaded_pages": downloaded_pages,
        "downloaded_objects": object_count,
        "complete": complete,
        "completed_at": iso_z(utc_now()) if complete else None,
    }
    atomic_json(run_dir / "manifest.json", manifest)
    if complete:
        state["last_successful_run"] = run_id
        state["in_progress"] = None
        atomic_json(state_path, state)
    else:
        print("S3 inventory paused and remains resumable.", file=sys.stderr)
    return manifest


def latest_complete_s3_manifest(root: Path) -> tuple[Path, dict[str, Any]] | None:
    completed: list[tuple[str, Path, dict[str, Any]]] = []
    for manifest_path in sorted((root / "s3-runs").glob("*/manifest.json")):
        manifest = read_json(manifest_path)
        if manifest.get("complete"):
            completed.append(
                (optional_string(manifest.get("completed_at")) or "", manifest_path, manifest)
            )
    if not completed:
        return None
    _, path, manifest = max(completed, key=lambda entry: (entry[0], str(entry[1])))
    return path, manifest


def s3_shard_id(prefix: str) -> str:
    leaf = prefix.rstrip("/").rsplit("/", 1)[-1]
    safe_leaf = "".join(character for character in leaf if character.isalnum() or character in "-_")
    digest = hashlib.sha256(prefix.encode("utf-8")).hexdigest()[:12]
    return f"{safe_leaf or 'prefix'}-{digest}"


def sync_s3_sharded_inventory(
    root: Path,
    list_url: str = DEFAULT_S3_LIST_URL,
    prefix: str = DEFAULT_S3_PREFIX,
    workers: int = 6,
    max_pages: int | None = None,
    timeout_seconds: float = 60,
    retries: int = 6,
    refresh: bool = False,
) -> dict[str, Any]:
    if workers < 1 or workers > 32:
        raise ValueError("workers must be between 1 and 32")
    prefixes = discover_s3_prefixes(list_url, prefix, timeout_seconds, retries)
    root.mkdir(parents=True, exist_ok=True)
    shards_root = root / "s3-shards"
    shards_root.mkdir(parents=True, exist_ok=True)

    def inventory(child_prefix: str) -> dict[str, Any]:
        shard_root = shards_root / s3_shard_id(child_prefix)
        existing = latest_complete_s3_manifest(shard_root)
        if existing is not None and not refresh:
            result = dict(existing[1])
        else:
            result = sync_s3_inventory(
                shard_root,
                list_url=list_url,
                prefix=child_prefix,
                max_pages=max_pages,
                timeout_seconds=timeout_seconds,
                retries=retries,
            )
        return {
            "prefix": child_prefix,
            "root": str(shard_root.relative_to(root)),
            "manifest": result,
        }

    shards: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(inventory, child): child for child in prefixes}
        for future in concurrent.futures.as_completed(futures):
            child = futures[future]
            shard = future.result()
            shards.append(shard)
            print(
                f"NOAA S3 shard {child}: "
                f"{shard['manifest'].get('downloaded_objects', 0)} objects",
                flush=True,
            )

    shards.sort(key=lambda item: item["prefix"])
    complete = all(bool(item["manifest"].get("complete")) for item in shards)
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "list_url": list_url,
        "prefix": prefix,
        "shards": shards,
        "downloaded_objects": sum(
            int(item["manifest"].get("downloaded_objects", 0)) for item in shards
        ),
        "downloaded_pages": sum(
            int(item["manifest"].get("downloaded_pages", 0)) for item in shards
        ),
        "raw_bytes": sum(
            s3_inventory_raw_bytes(root / item["root"]) for item in shards
        ),
        "complete": complete,
        "completed_at": iso_z(utc_now()) if complete else None,
    }
    atomic_json(root / "s3-shards-manifest.json", manifest)
    return manifest


def s3_inventory_raw_bytes(root: Path) -> int:
    total = 0
    latest = latest_complete_s3_manifest(root)
    if latest is None:
        manifests = sorted((root / "s3-runs").glob("*/manifest.json"))
        if not manifests:
            return 0
        manifest_path = manifests[-1]
    else:
        manifest_path = latest[0]
    for page in sorted((manifest_path.parent / "pages").glob("page-*.jsonl.gz")):
        for row in read_jsonl_gzip(page):
            total += int(row.get("size", 0))
    return total


def sync_metadata(
    root: Path,
    api_url: str = DEFAULT_API_URL,
    workers: int = 4,
    max_pages: int | None = None,
    full: bool = False,
    timeout_seconds: float = 60,
    retries: int = 6,
) -> dict[str, Any]:
    if workers < 1 or workers > 32:
        raise ValueError("workers must be between 1 and 32")
    if max_pages is not None and max_pages < 1:
        raise ValueError("max_pages must be positive")
    root.mkdir(parents=True, exist_ok=True)
    state_path = root / "state.json"
    state = read_json(state_path) if state_path.exists() else {}
    in_progress = state.get("in_progress")

    if isinstance(in_progress, dict) and not full:
        cutoff = required_string(in_progress.get("cutoff"), "in-progress cutoff")
        lower_bound = optional_string(in_progress.get("lower_bound"))
        run_id = required_string(in_progress.get("run_id"), "in-progress run id")
    else:
        cutoff = iso_z(utc_now())
        lower_bound = None if full else optional_string(state.get("last_successful_cutoff"))
        run_id = run_id_for(cutoff)
        in_progress = {
            "run_id": run_id,
            "cutoff": cutoff,
            "lower_bound": lower_bound,
            "started_at": iso_z(utc_now()),
        }
        state["schema_version"] = SCHEMA_VERSION
        state["in_progress"] = in_progress
        atomic_json(state_path, state)

    run_dir = root / "runs" / run_id
    pages_dir = run_dir / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    first_payload = fetch_page(
        api_url, 1, cutoff, lower_bound, timeout_seconds, retries
    )
    reported_pages = int(first_payload["totalPages"])
    target_pages = min(reported_pages, max_pages) if max_pages else reported_pages
    mirrored_at = iso_z(utc_now())
    first_path = page_path(pages_dir, 1)
    if not first_path.exists():
        write_page(first_path, first_payload, mirrored_at)

    missing_pages = [
        page for page in range(2, target_pages + 1) if not page_path(pages_dir, page).exists()
    ]
    completed = target_pages - len(missing_pages)
    progress_started = time.monotonic()
    status_path = root / "status.json"

    def write_progress(done: int, stage: str = "metadata_sync") -> None:
        elapsed = max(0.001, time.monotonic() - progress_started)
        advanced = max(0, done - completed)
        pages_per_second = advanced / elapsed
        remaining = max(0, target_pages - done)
        atomic_json(
            status_path,
            {
                "schema_version": SCHEMA_VERSION,
                "stage": stage,
                "mode": "baseline" if lower_bound is None else "incremental",
                "run_id": run_id,
                "cutoff": cutoff,
                "lower_bound": lower_bound,
                "total_records": int(first_payload["totalItems"]),
                "total_pages": target_pages,
                "completed_pages": done,
                "pages_per_second": pages_per_second,
                "eta_seconds": remaining / pages_per_second if pages_per_second else None,
                "updated_at": iso_z(utc_now()),
            },
        )

    write_progress(completed)
    print(
        f"NOAA metadata run {run_id}: {first_payload['totalItems']} records, "
        f"{target_pages} pages ({completed} already present)",
        flush=True,
    )

    def download(page: int) -> tuple[int, int]:
        payload = fetch_page(
            api_url, page, cutoff, lower_bound, timeout_seconds, retries
        )
        return page, write_page(page_path(pages_dir, page), payload, mirrored_at)

    item_count = count_lines(first_path)
    for existing_page in range(2, target_pages + 1):
        existing = page_path(pages_dir, existing_page)
        if existing.exists():
            item_count += count_lines(existing)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(download, page): page for page in missing_pages}
        for index, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            page, count = future.result()
            item_count += count
            if index % 25 == 0 or index == len(missing_pages):
                write_progress(completed + index)
                print(
                    f"downloaded {completed + index}/{target_pages} pages "
                    f"(latest page {page})",
                    flush=True,
                )

    complete = target_pages == reported_pages
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "cutoff": cutoff,
        "lower_bound": lower_bound,
        "api_url": api_url,
        "reported_total_items": first_payload["totalItems"],
        "reported_total_pages": reported_pages,
        "downloaded_pages": target_pages,
        "downloaded_records": item_count,
        "complete": complete,
        "completed_at": iso_z(utc_now()),
    }
    atomic_json(run_dir / "manifest.json", manifest)
    if complete:
        state["last_successful_cutoff"] = cutoff
        state["in_progress"] = None
        atomic_json(state_path, state)
        write_progress(target_pages, "metadata_sync_complete")
    else:
        print(
            "Partial run retained for validation; the incremental watermark was not advanced.",
            file=sys.stderr,
        )
    return manifest


def full_build_due(output: Path, interval_seconds: int) -> bool:
    manifest_path = output / "manifest.json"
    if not manifest_path.exists():
        return True
    manifest = read_json(manifest_path)
    value = optional_string(manifest.get("last_full_build_at")) or optional_string(manifest.get("built_at"))
    if not value:
        return True
    built = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (utc_now() - built).total_seconds() >= interval_seconds


def run_daemon(args: argparse.Namespace) -> None:
    if args.interval_seconds < 60:
        raise ValueError("interval-seconds must be at least 60")
    if args.full_rebuild_interval_seconds < args.interval_seconds:
        raise ValueError("full-rebuild-interval-seconds must not be shorter than interval-seconds")
    status_path = args.root / "status.json"
    while True:
        try:
            sync_manifest = sync_metadata(
                root=args.root,
                api_url=args.api_url,
                workers=args.workers,
                max_pages=args.max_pages,
                full=args.full,
                timeout_seconds=args.timeout_seconds,
                retries=args.retries,
            )
            force_full = (
                sync_manifest.get("lower_bound") is None
                or full_build_due(args.output, args.full_rebuild_interval_seconds)
            )
            build_mode = "full" if force_full else "incremental"
            atomic_json(
                status_path,
                {
                    "schema_version": SCHEMA_VERSION,
                    "stage": "parquet_build",
                    "mode": "baseline" if sync_manifest.get("lower_bound") is None else "incremental",
                    "run_id": sync_manifest["run_id"],
                    "cutoff": sync_manifest["cutoff"],
                    "total_records": sync_manifest["reported_total_items"],
                    "total_pages": sync_manifest["reported_total_pages"],
                    "completed_pages": sync_manifest["downloaded_pages"],
                    "build_mode": build_mode,
                    "updated_at": iso_z(utc_now()),
                },
            )
            build_manifest = build_parquet(
                args.root,
                args.output,
                overwrite=True,
                incremental_run_id=None if force_full else sync_manifest["run_id"],
                force_full=force_full,
            )
            completed_at = iso_z(utc_now())
            next_run_at = iso_z(utc_now() + dt.timedelta(seconds=args.interval_seconds))
            atomic_json(
                status_path,
                {
                    "schema_version": SCHEMA_VERSION,
                    "stage": "idle",
                    "mode": "incremental",
                    "run_id": sync_manifest["run_id"],
                    "cutoff": sync_manifest["cutoff"],
                    "total_records": sync_manifest["reported_total_items"],
                    "total_pages": sync_manifest["reported_total_pages"],
                    "completed_pages": sync_manifest["downloaded_pages"],
                    "metadata_records": build_manifest.get("current_trace_records"),
                    "file_index_records": build_manifest.get("file_index_records"),
                    "build_mode": build_manifest.get("build_mode"),
                    "affected_years": build_manifest.get("affected_years", []),
                    "last_full_build_at": build_manifest.get("last_full_build_at"),
                    "full_rebuild_interval_seconds": args.full_rebuild_interval_seconds,
                    "completed_at": completed_at,
                    "next_run_at": next_run_at,
                    "updated_at": completed_at,
                },
            )
            time.sleep(args.interval_seconds)
        except KeyboardInterrupt:
            return
        except Exception as error:
            retry_at = iso_z(utc_now() + dt.timedelta(minutes=5))
            atomic_json(
                status_path,
                {
                    "schema_version": SCHEMA_VERSION,
                    "stage": "retry_wait",
                    "error": str(error),
                    "retry_at": retry_at,
                    "updated_at": iso_z(utc_now()),
                },
            )
            print(f"metadata cycle failed; retrying in 300s: {error}", file=sys.stderr, flush=True)
            time.sleep(300)


def page_path(pages_dir: Path, page: int) -> Path:
    return pages_dir / f"page-{page:07d}.jsonl.gz"


def count_lines(path: Path) -> int:
    with gzip.open(path, mode="rt", encoding="utf-8") as handle:
        return sum(1 for _ in handle)


def normalize_record(item: Any, mirrored_at: str) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise ValueError("NOAA metadata item is not an object")
    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    other_locations = (
        item.get("otherLocations") if isinstance(item.get("otherLocations"), dict) else {}
    )
    file_name = optional_string(item.get("fileName"))
    s3_uri = optional_string(ci_get(other_locations, "s3"))
    file_uuid = derive_file_uuid(file_name, s3_uri)
    depth_reference = extract_depth_reference(metadata)
    sounder_draft_m = extract_sounder_draft(metadata)
    draft_applied = find_boolean(metadata, "draftApplied", "sounderDraftApplied")
    sound_speed_documented = find_boolean(
        metadata, "soundSpeedDocumented", "soundSpeedApplied"
    )
    position_offsets_documented = find_boolean(
        metadata, "positionOffsetsDocumented", "positionOffsetsApplied"
    )
    motion_offsets_applied = find_boolean(metadata, "motionOffsetsApplied")
    data_processed = find_boolean(metadata, "dataProcessed")
    vertical_reduction = find_process(metadata, "VerticalReduction")
    qualification, reasons = qualify(
        depth_reference=depth_reference,
        sounder_draft_m=sounder_draft_m,
        draft_applied=draft_applied,
        vertical_reduction=vertical_reduction,
        has_timestamp=bool(item.get("startTime") or find_value(metadata, "startTime")),
    )
    start_time = normalize_time(item.get("startTime") or find_value(metadata, "startTime"))
    end_time = normalize_time(item.get("endTime") or find_value(metadata, "endTime"))
    collection_year = extract_year(s3_uri, start_time, file_name)
    return {
        "schema_version": SCHEMA_VERSION,
        "mirrored_at": mirrored_at,
        "trace_id": optional_string(item.get("traceId")),
        "file_uuid": file_uuid,
        "file_name": file_name,
        "s3_uri": s3_uri,
        "external_id": optional_string(item.get("externalId")),
        "provider": optional_string(item.get("provider")),
        "platform": optional_string(item.get("platform")),
        "instrument": optional_string(item.get("instrument")),
        "publish": item.get("publish") if isinstance(item.get("publish"), bool) else None,
        "file_size": finite_number(item.get("fileSize")),
        "start_time": start_time,
        "end_time": end_time,
        "created": normalize_time(item.get("created")),
        "reviewed": normalize_time(item.get("reviewed")),
        "last_updated": normalize_time(item.get("lastUpdated")),
        "data_license": optional_string(item.get("dataLicense")),
        "collection_year": collection_year,
        "depth_reference": depth_reference,
        "sounder_draft_m": sounder_draft_m,
        "draft_applied": draft_applied,
        "sound_speed_documented": sound_speed_documented,
        "position_offsets_documented": position_offsets_documented,
        "motion_offsets_applied": motion_offsets_applied,
        "data_processed": data_processed,
        "vertical_reduction_reference": optional_string(
            ci_get(vertical_reduction, "reference") if vertical_reduction else None
        ),
        "vertical_reduction_method": optional_string(
            ci_get(vertical_reduction, "method") if vertical_reduction else None
        ),
        "vertical_reduction_model": optional_string(
            ci_get(vertical_reduction, "model") if vertical_reduction else None
        ),
        "qualification": qualification,
        "eligible_for_direct_fusion": qualification == "datum_corrected",
        "qualification_reasons_json": canonical_json(reasons),
        "geometry_json": canonical_json(item.get("geometry")),
        "metadata_json": canonical_json(metadata),
        "other_locations_json": canonical_json(other_locations),
        "raw_record_json": canonical_json(item),
    }


def derive_file_uuid(file_name: str | None, s3_uri: str | None) -> str | None:
    candidate = Path(s3_uri).name if s3_uri else file_name
    if not candidate:
        return None
    for suffix in ("_pointData.csv", ".tar.gz", ".geojson", ".csv"):
        if candidate.lower().endswith(suffix.lower()):
            return candidate[: -len(suffix)]
    return candidate


def extract_depth_reference(metadata: Mapping[str, Any]) -> str | None:
    crs = ci_get(metadata, "crs")
    if isinstance(crs, dict):
        direct = ci_get(crs, "vertical")
        if isinstance(direct, str):
            return normalize_reference(direct)
        properties = ci_get(crs, "properties")
        if isinstance(properties, dict):
            nested = ci_get(properties, "vertical")
            if isinstance(nested, str):
                return normalize_reference(nested)
    explicit = find_value(metadata, "referencePointForDepth", "depthReference")
    return normalize_reference(explicit) if isinstance(explicit, str) else None


def normalize_reference(value: str) -> str:
    compact = "".join(character for character in value.lower() if character.isalnum())
    aliases = {
        "transducer": "transducer",
        "echo sounder": "transducer",
        "sounder": "transducer",
        "waterline": "waterline",
        "surface": "waterline",
        "keel": "keel",
        "chartdatum": "chart_datum",
        "mllw": "chart_datum",
        "mlw": "chart_datum",
        "lat": "chart_datum",
        "ellipsoid": "ellipsoid",
        "gnss": "gnss",
    }
    return aliases.get(compact, compact or "unknown")


def extract_sounder_draft(metadata: Mapping[str, Any]) -> float | None:
    for value in walk(metadata):
        if not isinstance(value, dict):
            continue
        sensor_type = ci_get(value, "type", "sensorType")
        if isinstance(sensor_type, str) and sensor_type.lower() in {
            "sounder",
            "echo sounder",
            "echosounder",
            "multibeam",
        }:
            draft = finite_number(ci_get(value, "draft", "sounderDraft"))
            if draft is not None and draft >= 0:
                return draft
    draft = finite_number(find_value(metadata, "sounderDraft"))
    return draft if draft is None or draft >= 0 else None


def find_process(metadata: Mapping[str, Any], process_type: str) -> dict[str, Any] | None:
    for value in walk(metadata):
        if not isinstance(value, dict):
            continue
        kind = ci_get(value, "type")
        if isinstance(kind, str) and kind.lower() == process_type.lower():
            detail = ci_get(value, "detail")
            if isinstance(detail, dict):
                return detail
            return value
    return None


def qualify(
    *,
    depth_reference: str | None,
    sounder_draft_m: float | None,
    draft_applied: bool | None,
    vertical_reduction: Mapping[str, Any] | None,
    has_timestamp: bool,
) -> tuple[str, list[str]]:
    reasons: list[str] = []
    vertical_reference = (
        optional_string(ci_get(vertical_reduction, "reference"))
        if vertical_reduction
        else None
    )
    vertical_method = (
        optional_string(ci_get(vertical_reduction, "method"))
        if vertical_reduction
        else None
    )
    explicitly_reduced = bool(
        vertical_reference
        and normalize_reference(vertical_reference) in {"chart_datum", "ellipsoid"}
        and vertical_method
    )
    if depth_reference in {"chart_datum", "ellipsoid"} and explicitly_reduced:
        return "datum_corrected", ["documented_vertical_reduction"]
    if not depth_reference:
        return "raw_unknown", ["depth_reference_missing"]

    surface_resolvable = depth_reference == "waterline"
    if depth_reference == "transducer":
        if draft_applied is True:
            surface_resolvable = True
            reasons.append("draft_reported_applied")
        elif draft_applied is False and sounder_draft_m is not None:
            surface_resolvable = True
            reasons.append("draft_available_for_application")
        else:
            reasons.append("transducer_draft_or_applied_state_missing")
    elif depth_reference == "keel":
        reasons.append("waterline_to_keel_offset_missing")
    elif depth_reference == "waterline":
        reasons.append("waterline_reference")
    elif depth_reference in {"chart_datum", "ellipsoid"}:
        reasons.append("vertical_reduction_not_fully_documented")
    else:
        reasons.append(f"unsupported_depth_reference:{depth_reference}")

    if surface_resolvable and has_timestamp:
        reasons.append("timestamp_available_for_water_level_reduction")
        return "datum_correctable", reasons
    if surface_resolvable:
        reasons.append("timestamp_missing")
        return "surface_resolved", reasons
    return "reference_known", reasons


def build_parquet_full(root: Path, output: Path, overwrite: bool = False) -> dict[str, Any]:
    duckdb = load_duckdb()
    page_files = completed_page_files(root)
    if not page_files:
        raise RuntimeError(f"no completed metadata runs below {root}")
    if output.exists() and not overwrite:
        raise FileExistsError(f"output exists: {output}; pass --overwrite")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp-{os.getpid()}")
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir(parents=True)
    connection = duckdb.connect()
    try:
        connection.execute("PRAGMA threads=4")
        connection.execute(
            f"""
            CREATE TEMP TABLE metadata_history AS
            SELECT * FROM read_json(?, format='newline_delimited', union_by_name=true,
              columns={metadata_columns_sql()})
            """,
            [[str(path) for path in page_files]],
        )
        connection.execute(
            """
            CREATE TEMP TABLE metadata_records AS
            SELECT * EXCLUDE (rank)
            FROM (
              SELECT *, row_number() OVER (
                PARTITION BY trace_id ORDER BY try_cast(last_updated AS TIMESTAMPTZ) DESC NULLS LAST,
                try_cast(mirrored_at AS TIMESTAMPTZ) DESC
              ) rank
              FROM metadata_history
            )
            WHERE rank=1
            """
        )
        connection.execute(
            """
            CREATE TEMP TABLE metadata_file_index AS
            SELECT * EXCLUDE (rank)
            FROM (
              SELECT *, count(*) OVER (PARTITION BY file_uuid) file_uuid_candidate_count,
                row_number() OVER (
                PARTITION BY file_uuid ORDER BY try_cast(last_updated AS TIMESTAMPTZ) DESC NULLS LAST,
                trace_id DESC
              ) rank
              FROM metadata_records
              WHERE file_uuid IS NOT NULL
            )
            WHERE rank=1
            """
        )
        records_dir = temporary / "records"
        index_dir = temporary / "file-index"
        copy_partitioned(connection, "metadata_records", records_dir)
        copy_partitioned(connection, "metadata_file_index", index_dir)
        s3_page_files = latest_completed_s3_page_files(root)
        if s3_page_files:
            connection.execute(
                """
                CREATE TEMP TABLE s3_history AS
                SELECT * FROM read_json_auto(?, format='newline_delimited', union_by_name=true)
                """,
                [[str(path) for path in s3_page_files]],
            )
            connection.execute(
                """
                CREATE TEMP TABLE s3_objects AS
                SELECT * EXCLUDE (rank)
                FROM (
                  SELECT *, row_number() OVER (
                    PARTITION BY key ORDER BY try_cast(last_modified AS TIMESTAMPTZ) DESC NULLS LAST
                  ) rank
                  FROM s3_history
                )
                WHERE rank=1
                """
            )
            connection.execute(
                """
                CREATE TEMP TABLE s3_reconciliation AS
                SELECT
                  coalesce(s.file_uuid, m.file_uuid) file_uuid,
                  coalesce(s.collection_year, m.collection_year) collection_year,
                  s.key s3_key,
                  s.s3_uri,
                  s.size s3_size,
                  s.last_modified s3_last_modified,
                  s.etag s3_etag,
                  m.trace_id metadata_trace_id,
                  m.file_name metadata_file_name,
                  m.last_updated metadata_last_updated,
                  m.qualification metadata_qualification,
                  m.eligible_for_direct_fusion metadata_direct_fusion,
                  CASE
                    WHEN s.file_uuid IS NOT NULL AND m.file_uuid IS NOT NULL THEN 'matched'
                    WHEN s.file_uuid IS NOT NULL THEN 's3_without_metadata'
                    ELSE 'metadata_without_s3'
                  END reconciliation_status
                FROM s3_objects s
                FULL OUTER JOIN metadata_file_index m USING (file_uuid)
                """
            )
            copy_partitioned(connection, "s3_objects", temporary / "s3-objects")
            copy_partitioned(
                connection, "s3_reconciliation", temporary / "s3-reconciliation"
            )
        counts = {
            "history_records": connection.execute(
                "SELECT count(*) FROM metadata_history"
            ).fetchone()[0],
            "current_trace_records": connection.execute(
                "SELECT count(*) FROM metadata_records"
            ).fetchone()[0],
            "file_index_records": connection.execute(
                "SELECT count(*) FROM metadata_file_index"
            ).fetchone()[0],
            "missing_file_uuid": connection.execute(
                "SELECT count(*) FROM metadata_records WHERE file_uuid IS NULL"
            ).fetchone()[0],
            "qualification_counts": dict(
                connection.execute(
                    "SELECT qualification, count(*) FROM metadata_records GROUP BY qualification"
                ).fetchall()
            ),
        }
        if s3_page_files:
            counts.update(
                {
                    "s3_page_files": len(s3_page_files),
                    "s3_objects": connection.execute(
                        "SELECT count(*) FROM s3_objects"
                    ).fetchone()[0],
                    "s3_reconciliation_counts": dict(
                        connection.execute(
                            "SELECT reconciliation_status, count(*) FROM s3_reconciliation GROUP BY reconciliation_status"
                        ).fetchall()
                    ),
                }
            )
        built_at = iso_z(utc_now())
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "built_at": built_at,
            "last_full_build_at": built_at,
            "build_mode": "full",
            "affected_years": [],
            "source_root": str(root.resolve()),
            "page_files": len(page_files),
            **counts,
        }
        atomic_json(temporary / "manifest.json", manifest)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    finally:
        connection.close()
    if output.exists():
        swap_output(temporary, output)
    else:
        os.replace(temporary, output)
    return manifest


def completed_run(root: Path, run_id: str) -> tuple[dict[str, Any], list[Path]]:
    run_dir = root / "runs" / run_id
    manifest = read_json(run_dir / "manifest.json")
    if not manifest.get("complete"):
        raise RuntimeError(f"metadata run is incomplete: {run_id}")
    pages = sorted((run_dir / "pages").glob("page-*.jsonl.gz"))
    if len(pages) != manifest.get("downloaded_pages"):
        raise RuntimeError(f"incomplete page set for {run_id}")
    return manifest, pages


def swap_output(temporary: Path, output: Path) -> None:
    backup = output.with_name(f".{output.name}.previous-{os.getpid()}")
    shutil.rmtree(backup, ignore_errors=True)
    os.replace(output, backup)
    try:
        os.replace(temporary, output)
    except Exception:
        os.replace(backup, output)
        raise
    shutil.rmtree(backup)


def build_parquet_incremental(root: Path, output: Path, run_id: str) -> dict[str, Any]:
    """Apply one completed Crowbar delta by replacing only affected year partitions."""
    duckdb = load_duckdb()
    previous_path = output / "manifest.json"
    if not previous_path.exists():
        return build_parquet_full(root, output, overwrite=True)
    previous = read_json(previous_path)
    run_manifest, delta_pages = completed_run(root, run_id)
    temporary = output.with_name(f".{output.name}.tmp-{os.getpid()}")
    shutil.rmtree(temporary, ignore_errors=True)
    shutil.copytree(output, temporary, copy_function=os.link)

    if int(run_manifest.get("downloaded_records", 0)) == 0:
        manifest = {
            **previous,
            "built_at": iso_z(utc_now()),
            "build_mode": "incremental",
            "affected_years": [],
            "source_run_id": run_id,
            "page_files": int(previous.get("page_files", 0)) + len(delta_pages),
            "history_records": int(previous.get("history_records", 0)),
        }
        atomic_json(temporary / "manifest.json", manifest)
        swap_output(temporary, output)
        return manifest

    connection = duckdb.connect()
    try:
        connection.execute("PRAGMA threads=4")
        records_glob = str(output / "records" / "**" / "*.parquet")
        index_glob = str(output / "file-index" / "**" / "*.parquet")
        connection.execute(
            "CREATE TEMP TABLE existing_records AS SELECT * FROM read_parquet(?, union_by_name=true, hive_partitioning=true)",
            [records_glob],
        )
        connection.execute(
            "CREATE TEMP TABLE existing_file_index AS SELECT * FROM read_parquet(?, union_by_name=true, hive_partitioning=true)",
            [index_glob],
        )
        connection.execute(
            f"CREATE TEMP TABLE metadata_delta AS SELECT * FROM read_json(?, format='newline_delimited', union_by_name=true, columns={metadata_columns_sql()})",
            [[str(path) for path in delta_pages]],
        )
        connection.execute(
            """
            CREATE TEMP TABLE delta_latest AS
            SELECT * EXCLUDE (rank) FROM (
              SELECT *, row_number() OVER (
                PARTITION BY trace_id ORDER BY try_cast(last_updated AS TIMESTAMPTZ) DESC NULLS LAST,
                try_cast(mirrored_at AS TIMESTAMPTZ) DESC
              ) rank
              FROM metadata_delta
            ) WHERE rank=1
            """
        )
        connection.execute(
            """
            CREATE TEMP TABLE records_updated AS
            SELECT e.* FROM existing_records e
            WHERE NOT EXISTS (SELECT 1 FROM delta_latest d WHERE d.trace_id=e.trace_id)
            UNION ALL BY NAME
            SELECT * FROM delta_latest
            """
        )
        connection.execute(
            """
            CREATE TEMP TABLE affected_file_uuids AS
            SELECT DISTINCT file_uuid FROM (
              SELECT file_uuid FROM existing_records e
              WHERE EXISTS (SELECT 1 FROM delta_latest d WHERE d.trace_id=e.trace_id)
              UNION ALL
              SELECT file_uuid FROM delta_latest
            ) WHERE file_uuid IS NOT NULL
            """
        )
        connection.execute(
            """
            CREATE TEMP TABLE metadata_file_index AS
            SELECT * EXCLUDE (rank) FROM (
              SELECT *, count(*) OVER (PARTITION BY file_uuid) file_uuid_candidate_count,
                row_number() OVER (
                  PARTITION BY file_uuid ORDER BY try_cast(last_updated AS TIMESTAMPTZ) DESC NULLS LAST,
                  trace_id DESC
                ) rank
              FROM records_updated WHERE file_uuid IS NOT NULL
            ) WHERE rank=1
            """
        )
        years = {
            int(row[0])
            for row in connection.execute(
                """
                SELECT DISTINCT coalesce(collection_year,0) FROM (
                  SELECT collection_year FROM existing_records e
                  WHERE EXISTS (SELECT 1 FROM delta_latest d WHERE d.trace_id=e.trace_id)
                  UNION ALL SELECT collection_year FROM delta_latest
                  UNION ALL SELECT collection_year FROM existing_file_index i
                  WHERE EXISTS (SELECT 1 FROM affected_file_uuids a WHERE a.file_uuid=i.file_uuid)
                  UNION ALL SELECT collection_year FROM metadata_file_index i
                  WHERE EXISTS (SELECT 1 FROM affected_file_uuids a WHERE a.file_uuid=i.file_uuid)
                )
                """
            ).fetchall()
        }

        s3_glob = str(output / "s3-objects" / "**" / "*.parquet")
        has_s3 = bool(list((output / "s3-objects").glob("collection_year=*/*.parquet")))
        if has_s3:
            connection.execute(
                "CREATE TEMP TABLE s3_objects AS SELECT * FROM read_parquet(?, union_by_name=true, hive_partitioning=true)",
                [s3_glob],
            )
            connection.execute(
                """
                CREATE TEMP TABLE s3_reconciliation AS
                SELECT coalesce(s.file_uuid,m.file_uuid) file_uuid,
                  coalesce(s.collection_year,m.collection_year) collection_year,
                  s.key s3_key,s.s3_uri,s.size s3_size,s.last_modified s3_last_modified,
                  s.etag s3_etag,m.trace_id metadata_trace_id,m.file_name metadata_file_name,
                  m.last_updated metadata_last_updated,m.qualification metadata_qualification,
                  m.eligible_for_direct_fusion metadata_direct_fusion,
                  CASE WHEN s.file_uuid IS NOT NULL AND m.file_uuid IS NOT NULL THEN 'matched'
                    WHEN s.file_uuid IS NOT NULL THEN 's3_without_metadata'
                    ELSE 'metadata_without_s3' END reconciliation_status
                FROM s3_objects s FULL OUTER JOIN metadata_file_index m USING (file_uuid)
                """
            )
            years.update(
                int(row[0]) for row in connection.execute(
                    """SELECT DISTINCT coalesce(collection_year,0) FROM s3_reconciliation r
                    WHERE EXISTS (SELECT 1 FROM affected_file_uuids a WHERE a.file_uuid=r.file_uuid)"""
                ).fetchall()
            )

        if years:
            year_list = ",".join(str(year) for year in sorted(years))
            for area in ("records", "file-index", "s3-reconciliation"):
                for year in years:
                    shutil.rmtree(temporary / area / f"collection_year={year}", ignore_errors=True)
            connection.execute(
                f"CREATE TEMP VIEW affected_records AS SELECT * FROM records_updated WHERE coalesce(collection_year,0) IN ({year_list})"
            )
            connection.execute(
                f"CREATE TEMP VIEW affected_file_index AS SELECT * FROM metadata_file_index WHERE coalesce(collection_year,0) IN ({year_list})"
            )
            copy_partitioned(connection, "affected_records", temporary / "records")
            copy_partitioned(connection, "affected_file_index", temporary / "file-index")
            if has_s3:
                connection.execute(
                    f"CREATE TEMP VIEW affected_reconciliation AS SELECT * FROM s3_reconciliation WHERE coalesce(collection_year,0) IN ({year_list})"
                )
                copy_partitioned(connection, "affected_reconciliation", temporary / "s3-reconciliation")

        counts = {
            "history_records": int(previous.get("history_records", 0)) + int(run_manifest.get("downloaded_records", 0)),
            "current_trace_records": connection.execute("SELECT count(*) FROM records_updated").fetchone()[0],
            "file_index_records": connection.execute("SELECT count(*) FROM metadata_file_index").fetchone()[0],
            "missing_file_uuid": connection.execute("SELECT count(*) FROM records_updated WHERE file_uuid IS NULL").fetchone()[0],
            "qualification_counts": dict(connection.execute(
                "SELECT qualification,count(*) FROM records_updated GROUP BY qualification"
            ).fetchall()),
        }
        if has_s3:
            counts.update({
                "s3_page_files": previous.get("s3_page_files"),
                "s3_objects": connection.execute("SELECT count(*) FROM s3_objects").fetchone()[0],
                "s3_reconciliation_counts": dict(connection.execute(
                    "SELECT reconciliation_status,count(*) FROM s3_reconciliation GROUP BY reconciliation_status"
                ).fetchall()),
            })
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "built_at": iso_z(utc_now()),
            "last_full_build_at": previous.get("last_full_build_at", previous.get("built_at")),
            "build_mode": "incremental",
            "affected_years": sorted(years),
            "source_run_id": run_id,
            "source_root": str(root.resolve()),
            "page_files": int(previous.get("page_files", 0)) + len(delta_pages),
            **counts,
        }
        atomic_json(temporary / "manifest.json", manifest)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    finally:
        connection.close()
    swap_output(temporary, output)
    return manifest


def build_parquet(
    root: Path,
    output: Path,
    overwrite: bool = False,
    incremental_run_id: str | None = None,
    force_full: bool = False,
) -> dict[str, Any]:
    if force_full or incremental_run_id is None or not (output / "manifest.json").exists():
        return build_parquet_full(root, output, overwrite=overwrite or force_full)
    return build_parquet_incremental(root, output, incremental_run_id)


def copy_partitioned(connection: Any, table: str, output: Path) -> None:
    sql_path = sql_literal(str(output))
    connection.execute(
        f"""
        COPY (SELECT * REPLACE (coalesce(collection_year, 0) AS collection_year) FROM {table})
        TO {sql_path} (
          FORMAT PARQUET,
          COMPRESSION ZSTD,
          PARTITION_BY (collection_year),
          ROW_GROUP_SIZE 100000,
          OVERWRITE_OR_IGNORE
        )
        """
    )


def join_soundings(
    metadata: Path,
    soundings_glob: str,
    output: Path,
    overwrite: bool = False,
) -> dict[str, Any]:
    duckdb = load_duckdb()
    index_glob = str(metadata / "file-index" / "**" / "*.parquet")
    prepare_output(output, overwrite)
    temporary = output.with_name(f".{output.name}.tmp-{os.getpid()}")
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir(parents=True)
    connection = duckdb.connect()
    try:
        connection.execute(
            f"CREATE TEMP VIEW soundings AS SELECT * FROM read_parquet({sql_literal(soundings_glob)}, union_by_name=true)"
        )
        columns = {
            row[1].lower()
            for row in connection.execute("PRAGMA table_info('soundings')").fetchall()
        }
        if "file_uuid" not in columns:
            raise RuntimeError("sounding Parquet must contain a file_uuid column")
        connection.execute(
            f"CREATE TEMP VIEW metadata AS SELECT * FROM read_parquet({sql_literal(index_glob)}, union_by_name=true, hive_partitioning=true)"
        )
        destination = sql_literal(str(temporary / "enriched.parquet"))
        connection.execute(
            f"""
            COPY (
              SELECT s.*,
                m.trace_id AS csb_metadata_trace_id,
                m.qualification AS csb_metadata_qualification,
                m.eligible_for_direct_fusion AS csb_metadata_direct_fusion,
                m.depth_reference AS csb_metadata_depth_reference,
                m.sounder_draft_m AS csb_metadata_sounder_draft_m,
                m.draft_applied AS csb_metadata_draft_applied,
                m.sound_speed_documented AS csb_metadata_sound_speed_documented,
                m.position_offsets_documented AS csb_metadata_position_offsets_documented,
                m.motion_offsets_applied AS csb_metadata_motion_offsets_applied,
                m.vertical_reduction_reference AS csb_metadata_vertical_reference,
                m.vertical_reduction_method AS csb_metadata_vertical_method,
                m.vertical_reduction_model AS csb_metadata_vertical_model,
                m.qualification_reasons_json AS csb_metadata_qualification_reasons,
                m.file_uuid_candidate_count AS csb_metadata_candidate_count
              FROM soundings s
              LEFT JOIN metadata m USING (file_uuid)
            ) TO {destination} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)
            """
        )
        totals = connection.execute(
            """
            SELECT count(*), count(m.trace_id)
            FROM soundings s LEFT JOIN metadata m USING (file_uuid)
            """
        ).fetchone()
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "built_at": iso_z(utc_now()),
            "metadata": str(metadata.resolve()),
            "soundings_glob": soundings_glob,
            "soundings": totals[0],
            "matched_soundings": totals[1],
            "unmatched_soundings": totals[0] - totals[1],
        }
        atomic_json(temporary / "manifest.json", manifest)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    finally:
        connection.close()
    os.replace(temporary, output)
    return manifest


def completed_page_files(root: Path) -> list[Path]:
    result: list[Path] = []
    for manifest_path in sorted((root / "runs").glob("*/manifest.json")):
        manifest = read_json(manifest_path)
        if not manifest.get("complete"):
            continue
        pages = sorted((manifest_path.parent / "pages").glob("page-*.jsonl.gz"))
        if len(pages) != manifest.get("downloaded_pages"):
            raise RuntimeError(f"incomplete page set for {manifest_path.parent.name}")
        result.extend(pages)
    return result


def latest_completed_s3_page_files(root: Path) -> list[Path]:
    shard_manifest_path = root / "s3-shards-manifest.json"
    if shard_manifest_path.exists():
        shard_manifest = read_json(shard_manifest_path)
        if not shard_manifest.get("complete"):
            return []
        pages: list[Path] = []
        for shard in shard_manifest.get("shards", []):
            if not isinstance(shard, dict):
                raise ValueError("invalid S3 shard manifest entry")
            shard_root = root / required_string(shard.get("root"), "S3 shard root")
            shard_pages = latest_completed_s3_page_files(shard_root)
            if not shard_pages:
                raise RuntimeError(f"complete S3 shard has no pages: {shard_root}")
            pages.extend(shard_pages)
        return pages

    latest = latest_complete_s3_manifest(root)
    if latest is None:
        return []
    manifest_path, manifest = latest
    pages = sorted((manifest_path.parent / "pages").glob("page-*.jsonl.gz"))
    if len(pages) != manifest.get("downloaded_pages"):
        raise RuntimeError(f"incomplete S3 page set for {manifest_path.parent.name}")
    return pages


def read_jsonl_gzip(path: Path) -> Iterable[dict[str, Any]]:
    with gzip.open(path, mode="rt", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"expected object at {path}:{line_number}")
            yield value


def inventory_packs(
    page_files: Sequence[Path],
    target_pack_bytes: int,
    max_pack_objects: int,
    max_objects: int | None = None,
    max_raw_bytes: int | None = None,
) -> Iterable[list[dict[str, Any]]]:
    if target_pack_bytes < 1 or max_pack_objects < 1:
        raise ValueError("pack byte and object limits must be positive")
    selected_objects = 0
    selected_bytes = 0
    pack: list[dict[str, Any]] = []
    pack_bytes = 0
    for page in page_files:
        for row in read_jsonl_gzip(page):
            size = int(row.get("size", 0))
            if max_objects is not None and selected_objects >= max_objects:
                if pack:
                    yield pack
                return
            if max_raw_bytes is not None and selected_bytes >= max_raw_bytes:
                if pack:
                    yield pack
                return
            if pack and (
                len(pack) >= max_pack_objects
                or pack_bytes + size > target_pack_bytes
            ):
                yield pack
                pack = []
                pack_bytes = 0
            pack.append(row)
            pack_bytes += size
            selected_objects += 1
            selected_bytes += size
    if pack:
        yield pack


def pack_id(rows: Sequence[Mapping[str, Any]]) -> str:
    digest = hashlib.sha256()
    for row in rows:
        digest.update(required_string(row.get("key"), "S3 object key").encode("utf-8"))
        digest.update(b"\0")
        digest.update((optional_string(row.get("etag")) or "").encode("ascii"))
        digest.update(b"\0")
        digest.update(str(int(row.get("size", 0))).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()[:24]


def object_download_url(list_url: str, key: str) -> str:
    base = list_url.split("?", 1)[0].rstrip("/") + "/"
    return base + urllib.parse.quote(key, safe="/")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_s3_object(
    row: Mapping[str, Any],
    destination: Path,
    list_url: str,
    timeout_seconds: float,
    retries: int,
) -> dict[str, Any]:
    key = required_string(row.get("key"), "S3 object key")
    expected_size = int(row.get("size", 0))
    expected_etag = optional_string(row.get("etag"))
    url = object_download_url(list_url, key)
    for attempt in range(retries + 1):
        temporary = destination.with_suffix(destination.suffix + ".part")
        temporary.unlink(missing_ok=True)
        md5 = hashlib.md5(usedforsecurity=False)
        sha256 = hashlib.sha256()
        byte_count = 0
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "signalk-bathymetry-noaa-sounding-archive/1"},
            )
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                with temporary.open("wb") as output:
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        output.write(block)
                        md5.update(block)
                        sha256.update(block)
                        byte_count += len(block)
            if byte_count != expected_size:
                raise ValueError(
                    f"size mismatch for {key}: expected {expected_size}, received {byte_count}"
                )
            if (
                expected_etag
                and "-" not in expected_etag
                and len(expected_etag) == 32
                and md5.hexdigest().lower() != expected_etag.lower()
            ):
                raise ValueError(f"ETag mismatch for {key}")
            os.replace(temporary, destination)
            return {
                "local_path": str(destination),
                "key": key,
                "etag": expected_etag,
                "last_modified": optional_string(row.get("last_modified")),
                "size": byte_count,
                "source_sha256": sha256.hexdigest(),
            }
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            temporary.unlink(missing_ok=True)
            if attempt >= retries:
                raise RuntimeError(f"NOAA sounding download failed for {key}: {error}") from error
            delay = min(60.0, 0.75 * (2**attempt)) + random.random() * 0.5
            time.sleep(delay)
    raise AssertionError("retry loop exhausted")


def write_sounding_pack(
    rows: Sequence[Mapping[str, Any]],
    output: Path,
    list_url: str,
    timeout_seconds: float,
    retries: int,
    min_free_bytes: int,
) -> dict[str, Any]:
    identifier = pack_id(rows)
    years = {row.get("collection_year") for row in rows}
    year = next(iter(years)) if len(years) == 1 else None
    year_directory = f"collection_year={year if year is not None else 'unknown'}"
    destination_dir = output / "soundings" / year_directory
    destination = destination_dir / f"part-{identifier}.parquet"
    sidecar = destination.with_suffix(".manifest.json")
    if destination.exists() and sidecar.exists():
        manifest = read_json(sidecar)
        if manifest.get("source_fingerprint") != identifier:
            raise RuntimeError(f"sounding pack fingerprint mismatch: {destination}")
        if manifest.get("parquet_sha256") != sha256_file(destination):
            raise RuntimeError(f"sounding pack checksum mismatch: {destination}")
        return {**manifest, "reused": True}
    if destination.exists() or sidecar.exists():
        raise RuntimeError(f"incomplete sounding pack output requires inspection: {destination}")

    raw_bytes = sum(int(row.get("size", 0)) for row in rows)
    output.mkdir(parents=True, exist_ok=True)
    free_bytes = shutil.disk_usage(output).free
    if free_bytes - raw_bytes < min_free_bytes:
        raise RuntimeError(
            f"storage reserve would be breached: {free_bytes} bytes free, "
            f"{raw_bytes} bytes needed temporarily, {min_free_bytes} bytes reserved"
        )
    destination_dir.mkdir(parents=True, exist_ok=True)
    work_root = output / ".work"
    work_root.mkdir(parents=True, exist_ok=True)
    temporary_dir = Path(tempfile.mkdtemp(prefix=f"pack-{identifier}-", dir=work_root))
    temporary_output = temporary_dir / "soundings.parquet"
    connection = None
    try:
        downloads = []
        for index, row in enumerate(rows):
            local = temporary_dir / f"source-{index:04d}.csv"
            downloads.append(
                download_s3_object(
                    row, local, list_url, timeout_seconds=timeout_seconds, retries=retries
                )
            )
        duckdb = load_duckdb()
        connection = duckdb.connect()
        connection.execute("PRAGMA threads=2")
        connection.execute(
            """
            CREATE TEMP TABLE source_manifest(
              local_path VARCHAR, source_key VARCHAR, source_etag VARCHAR,
              source_last_modified VARCHAR, source_size UBIGINT, source_sha256 VARCHAR
            )
            """
        )
        connection.executemany(
            "INSERT INTO source_manifest VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    item["local_path"],
                    item["key"],
                    item["etag"],
                    item["last_modified"],
                    item["size"],
                    item["source_sha256"],
                )
                for item in downloads
            ],
        )
        paths = [item["local_path"] for item in downloads]
        quoted_output = sql_literal(str(temporary_output))
        connection.execute(
            f"""
            COPY (
              SELECT
                r.UNIQUE_ID unique_id,
                r.FILE_UUID file_uuid,
                r.LON lon,
                r.LAT lat,
                r.DEPTH depth,
                r.TIME "time",
                r.PLATFORM_NAME platform_name,
                r.PROVIDER provider,
                m.source_key,
                m.source_etag,
                m.source_last_modified,
                m.source_size,
                m.source_sha256
              FROM read_csv(
                ?, header=true, all_varchar=true, filename=true,
                columns={{
                  'UNIQUE_ID': 'VARCHAR', 'FILE_UUID': 'VARCHAR',
                  'LON': 'VARCHAR', 'LAT': 'VARCHAR', 'DEPTH': 'VARCHAR',
                  'TIME': 'VARCHAR', 'PLATFORM_NAME': 'VARCHAR', 'PROVIDER': 'VARCHAR'
                }}
              ) r
              JOIN source_manifest m ON r.filename = m.local_path
            ) TO {quoted_output}
            (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 250000)
            """,
            [paths],
        )
        sounding_count = int(
            connection.execute(
                "SELECT count(*) FROM read_parquet(?)", [str(temporary_output)]
            ).fetchone()[0]
        )
        parquet_bytes = temporary_output.stat().st_size
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "source_fingerprint": identifier,
            "source_objects": len(rows),
            "source_bytes": raw_bytes,
            "soundings": sounding_count,
            "parquet_bytes": parquet_bytes,
            "parquet_sha256": sha256_file(temporary_output),
            "created_at": iso_z(utc_now()),
            "first_key": required_string(rows[0].get("key"), "first S3 key"),
            "last_key": required_string(rows[-1].get("key"), "last S3 key"),
        }
        os.replace(temporary_output, destination)
        atomic_json(sidecar, manifest)
        return {**manifest, "reused": False}
    finally:
        if connection is not None:
            connection.close()
        shutil.rmtree(temporary_dir, ignore_errors=True)


def mirror_soundings(
    inventory_root: Path,
    output: Path,
    list_url: str = DEFAULT_S3_LIST_URL,
    workers: int = 4,
    target_pack_bytes: int = 256 * 1024 * 1024,
    max_pack_objects: int = 250,
    max_objects: int | None = None,
    max_raw_bytes: int | None = None,
    min_free_bytes: int = 50 * 1024 * 1024 * 1024,
    timeout_seconds: float = 120,
    retries: int = 6,
) -> dict[str, Any]:
    if workers < 1 or workers > 16:
        raise ValueError("workers must be between 1 and 16")
    page_files = latest_completed_s3_page_files(inventory_root)
    if not page_files:
        raise RuntimeError(f"no complete S3 inventory below {inventory_root}")
    output.mkdir(parents=True, exist_ok=True)
    packs = inventory_packs(
        page_files,
        target_pack_bytes=target_pack_bytes,
        max_pack_objects=max_pack_objects,
        max_objects=max_objects,
        max_raw_bytes=max_raw_bytes,
    )
    totals = {
        "source_objects": 0,
        "source_bytes": 0,
        "soundings": 0,
        "parquet_bytes": 0,
        "packs": 0,
        "reused_packs": 0,
    }

    def process(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        return write_sounding_pack(
            rows,
            output,
            list_url=list_url,
            timeout_seconds=timeout_seconds,
            retries=retries,
            min_free_bytes=min_free_bytes,
        )

    pending: set[concurrent.futures.Future[dict[str, Any]]] = set()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for rows in packs:
            pending.add(executor.submit(process, rows))
            if len(pending) < workers * 2:
                continue
            done, pending = concurrent.futures.wait(
                pending, return_when=concurrent.futures.FIRST_COMPLETED
            )
            for future in done:
                accumulate_pack_totals(totals, future.result())
                print_pack_progress(totals)
        for future in concurrent.futures.as_completed(pending):
            accumulate_pack_totals(totals, future.result())
            print_pack_progress(totals)

    limited = max_objects is not None or max_raw_bytes is not None
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "inventory_root": str(inventory_root.resolve()),
        "list_url": list_url,
        **totals,
        "complete": not limited,
        "limited": limited,
        "completed_at": iso_z(utc_now()),
    }
    if totals["source_bytes"]:
        manifest["compression_ratio"] = totals["source_bytes"] / max(
            1, totals["parquet_bytes"]
        )
    atomic_json(output / "manifest.json", manifest)
    return manifest


def accumulate_pack_totals(totals: dict[str, int], result: Mapping[str, Any]) -> None:
    totals["source_objects"] += int(result["source_objects"])
    totals["source_bytes"] += int(result["source_bytes"])
    totals["soundings"] += int(result["soundings"])
    totals["parquet_bytes"] += int(result["parquet_bytes"])
    totals["packs"] += 1
    totals["reused_packs"] += int(bool(result.get("reused")))


def print_pack_progress(totals: Mapping[str, int]) -> None:
    print(
        f"NOAA sounding archive: {totals['source_objects']} objects, "
        f"{totals['source_bytes']} source bytes, {totals['soundings']} soundings, "
        f"{totals['parquet_bytes']} Parquet bytes",
        flush=True,
    )


def prepare_output(output: Path, overwrite: bool) -> None:
    if output.exists():
        if not overwrite:
            raise FileExistsError(f"output exists: {output}; pass --overwrite")
        if output.is_dir():
            shutil.rmtree(output)
        else:
            output.unlink()
    output.parent.mkdir(parents=True, exist_ok=True)


def load_duckdb() -> Any:
    try:
        import duckdb  # type: ignore
    except ImportError as error:
        raise RuntimeError(
            "DuckDB Python is required for build/join; install tools/noaa-csb-metadata/requirements.txt"
        ) from error
    return duckdb


def canonical_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def required_string(value: Any, label: str) -> str:
    result = optional_string(value)
    if result is None:
        raise ValueError(f"missing {label}")
    return result


def optional_string(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def ci_get(value: Mapping[str, Any], *names: str) -> Any:
    wanted = {name.lower() for name in names}
    for key, item in value.items():
        if key.lower() in wanted:
            return item
    return None


def walk(value: Any) -> Iterable[Any]:
    yield value
    if isinstance(value, dict):
        for nested in value.values():
            yield from walk(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from walk(nested)


def find_value(value: Any, *names: str) -> Any:
    wanted = {name.lower() for name in names}
    for candidate in walk(value):
        if isinstance(candidate, dict):
            for key, item in candidate.items():
                if key.lower() in wanted:
                    return item
    return None


def find_boolean(value: Any, *names: str) -> bool | None:
    candidate = find_value(value, *names)
    if isinstance(candidate, bool):
        return candidate
    if isinstance(candidate, str):
        if candidate.lower() == "true":
            return True
        if candidate.lower() == "false":
            return False
    return None


def normalize_time(value: Any) -> str | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return iso_z(dt.datetime.fromtimestamp(float(value) / 1000, dt.timezone.utc))
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def extract_year(
    s3_uri: str | None, start_time: str | None, file_name: str | None
) -> int | None:
    if s3_uri:
        parts = s3_uri.split("/")
        for index, part in enumerate(parts):
            if part == "csv" and index + 1 < len(parts) and parts[index + 1].isdigit():
                return int(parts[index + 1])
    for candidate in (start_time, file_name):
        if candidate and len(candidate) >= 4 and candidate[:4].isdigit():
            year = int(candidate[:4])
            if 1800 <= year <= 2200:
                return year
    return None


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "daemon":
        run_daemon(args)
        return 0
    if args.command == "sync-s3":
        manifest = sync_s3_inventory(
            root=args.root,
            list_url=args.list_url,
            prefix=args.prefix,
            max_pages=args.max_pages,
            timeout_seconds=args.timeout_seconds,
            retries=args.retries,
        )
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0
    if args.command == "sync-s3-sharded":
        manifest = sync_s3_sharded_inventory(
            root=args.root,
            list_url=args.list_url,
            prefix=args.prefix,
            workers=args.workers,
            max_pages=args.max_pages,
            timeout_seconds=args.timeout_seconds,
            retries=args.retries,
            refresh=args.refresh,
        )
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0
    if args.command == "mirror-soundings":
        manifest = mirror_soundings(
            inventory_root=args.inventory_root,
            output=args.output,
            list_url=args.list_url,
            workers=args.workers,
            target_pack_bytes=args.target_pack_bytes,
            max_pack_objects=args.max_pack_objects,
            max_objects=args.max_objects,
            max_raw_bytes=args.max_raw_bytes,
            min_free_bytes=args.min_free_bytes,
            timeout_seconds=args.timeout_seconds,
            retries=args.retries,
        )
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0
    if args.command in {"sync", "run"}:
        manifest = sync_metadata(
            root=args.root,
            api_url=args.api_url,
            workers=args.workers,
            max_pages=args.max_pages,
            full=args.full,
            timeout_seconds=args.timeout_seconds,
            retries=args.retries,
        )
        print(json.dumps(manifest, indent=2, sort_keys=True))
        if args.command == "sync":
            return 0
        if args.inventory_s3:
            s3_manifest = sync_s3_inventory(
                root=args.root,
                list_url=args.s3_list_url,
                prefix=args.s3_prefix,
                timeout_seconds=args.timeout_seconds,
                retries=args.retries,
            )
            print(json.dumps(s3_manifest, indent=2, sort_keys=True))
    if args.command in {"build", "run"}:
        manifest = build_parquet(
            args.root,
            args.output,
            args.overwrite,
            incremental_run_id=getattr(args, "incremental_run_id", None),
            force_full=getattr(args, "force_full", False),
        )
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0
    if args.command == "join":
        manifest = join_soundings(
            args.metadata, args.soundings_glob, args.output, args.overwrite
        )
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0
    raise AssertionError(f"unknown command {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
