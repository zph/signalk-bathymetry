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

    build = subparsers.add_parser("build", help="build partitioned metadata Parquet")
    build.add_argument("--root", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--overwrite", action="store_true")

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
    else:
        print(
            "Partial run retained for validation; the incremental watermark was not advanced.",
            file=sys.stderr,
        )
    return manifest


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


def build_parquet(root: Path, output: Path, overwrite: bool = False) -> dict[str, Any]:
    duckdb = load_duckdb()
    page_files = completed_page_files(root)
    if not page_files:
        raise RuntimeError(f"no completed metadata runs below {root}")
    prepare_output(output, overwrite)
    temporary = output.with_name(f".{output.name}.tmp-{os.getpid()}")
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir(parents=True)
    connection = duckdb.connect()
    try:
        connection.execute("PRAGMA threads=4")
        connection.execute(
            """
            CREATE TEMP TABLE metadata_history AS
            SELECT * FROM read_json_auto(?, format='newline_delimited', union_by_name=true)
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
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "built_at": iso_z(utc_now()),
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
    os.replace(temporary, output)
    return manifest


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
    completed: list[tuple[str, Path, dict[str, Any]]] = []
    for manifest_path in sorted((root / "s3-runs").glob("*/manifest.json")):
        manifest = read_json(manifest_path)
        if manifest.get("complete"):
            completed.append(
                (optional_string(manifest.get("completed_at")) or "", manifest_path, manifest)
            )
    if not completed:
        return []
    _, manifest_path, manifest = max(completed, key=lambda entry: (entry[0], str(entry[1])))
    pages = sorted((manifest_path.parent / "pages").glob("page-*.jsonl.gz"))
    if len(pages) != manifest.get("downloaded_pages"):
        raise RuntimeError(f"incomplete S3 page set for {manifest_path.parent.name}")
    return pages


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
        manifest = build_parquet(args.root, args.output, args.overwrite)
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
