#!/usr/bin/env python3
"""Extract and upload thumbnails for House Oversight DOJ native videos.

Frames are decoded with the system GStreamer installation, so this does not
require ffmpeg or duplicate the source videos. Production document IDs are the
local import IDs plus the offset used by the D1 import.
"""

import argparse
import os
import sys
import tempfile
from pathlib import Path

import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv
from PIL import Image

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst

PROJECT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_DIR / "src"))

from models import Document, get_engine, get_session

BUCKET = "epstein-files"
DATA_SET = "house-oversight-doj"
DEFAULT_DOCUMENT_ID_OFFSET = 20_912
DEFAULT_SOURCE_DIR = (
    Path.home()
    / "epstein-raw"
    / "house-oversight-doj"
    / "Prod 01_ 20250822"
)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--document-id", type=int, action="append", help="Local document ID to process; repeatable")
    parser.add_argument("--document-id-offset", type=int, default=DEFAULT_DOCUMENT_ID_OFFSET)
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--seek-seconds", type=float, default=5.0)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--quality", type=int, default=85)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--force", action="store_true", help="Replace thumbnails already in R2")
    parser.add_argument("--no-upload", action="store_true", help="Extract frames without changing R2")
    parser.add_argument("--output-dir", type=Path, help="Keep generated JPEGs in this directory")
    return parser.parse_args()


def video_documents(document_ids=None):
    session = get_session(get_engine())
    try:
        query = (
            session.query(Document)
            .filter(Document.data_set == DATA_SET, Document.document_type == "video")
            .order_by(Document.id)
        )
        if document_ids:
            query = query.filter(Document.id.in_(document_ids))
        return query.all()
    finally:
        session.close()


def native_source(source_dir, document):
    stem = Path(document.local_path).stem
    matches = sorted(source_dir.glob(f"VOL00001/NATIVES/*/{stem}.*"))
    if not matches:
        raise FileNotFoundError(f"native source not found for {document.filename}")
    return matches[0]


def extract_frame(source, destination, seek_seconds, width, quality):
    uri = Gst.filename_to_uri(str(source.resolve()))
    pipeline = Gst.parse_launch(
        f'uridecodebin uri="{uri}" ! queue ! videoconvert ! videoscale ! '
        f'video/x-raw,format=RGB,width={width},pixel-aspect-ratio=1/1 ! '
        'appsink name=thumbnail_sink sync=false max-buffers=1 drop=true'
    )
    sink = pipeline.get_by_name("thumbnail_sink")
    try:
        pipeline.set_state(Gst.State.PAUSED)
        state_result, state, _ = pipeline.get_state(30 * Gst.SECOND)
        if state_result == Gst.StateChangeReturn.FAILURE or state < Gst.State.PAUSED:
            raise RuntimeError("video decoder did not preroll")

        duration_ok, duration = pipeline.query_duration(Gst.Format.TIME)
        requested = max(0, int(seek_seconds * Gst.SECOND))
        if duration_ok and duration > 0:
            requested = min(requested, max(0, duration - Gst.SECOND))
        if requested and not pipeline.seek_simple(
            Gst.Format.TIME,
            Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
            requested,
        ):
            raise RuntimeError(f"could not seek to {seek_seconds:g}s")

        pipeline.set_state(Gst.State.PLAYING)
        sample = sink.emit("try-pull-sample", 45 * Gst.SECOND)
        if sample is None:
            bus = pipeline.get_bus()
            message = bus.pop_filtered(Gst.MessageType.ERROR)
            if message:
                error, debug = message.parse_error()
                raise RuntimeError(f"decoder error: {error}; {debug or 'no details'}")
            raise TimeoutError("timed out waiting for a decoded frame")

        caps = sample.get_caps().get_structure(0)
        frame_width = caps.get_value("width")
        frame_height = caps.get_value("height")
        buffer = sample.get_buffer()
        mapped, map_info = buffer.map(Gst.MapFlags.READ)
        if not mapped:
            raise RuntimeError("could not map decoded frame")
        try:
            stride = len(map_info.data) // frame_height
            image = Image.frombuffer(
                "RGB",
                (frame_width, frame_height),
                map_info.data,
                "raw",
                "RGB",
                stride,
                1,
            ).copy()
        finally:
            buffer.unmap(map_info)

        destination.parent.mkdir(parents=True, exist_ok=True)
        image.save(destination, "JPEG", quality=quality, optimize=True)
    finally:
        pipeline.set_state(Gst.State.NULL)


def r2_client():
    required = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT_URL"]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise RuntimeError(f"missing R2 configuration: {', '.join(missing)}")
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def object_exists(client, key):
    try:
        client.head_object(Bucket=BUCKET, Key=key)
        return True
    except ClientError as error:
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        code = error.response.get("Error", {}).get("Code")
        if status == 404 or code in {"404", "NoSuchKey", "NotFound"}:
            return False
        raise


def upload_thumbnail(client, path, key):
    client.upload_file(
        str(path),
        BUCKET,
        key,
        ExtraArgs={
            "ContentType": "image/jpeg",
            "CacheControl": "public, max-age=31536000, immutable",
        },
    )


def process(args, output_dir):
    docs = video_documents(args.document_id)
    if args.limit is not None:
        docs = docs[: args.limit]
    if not docs:
        raise RuntimeError("no matching video documents")

    client = None if args.no_upload else r2_client()
    completed = skipped = failed = 0
    print(f"Found {len(docs)} {DATA_SET} videos")
    for index, document in enumerate(docs, 1):
        production_id = args.document_id_offset + document.id
        key = f"thumbnails/{production_id}.jpg"
        try:
            if client and not args.force and object_exists(client, key):
                skipped += 1
                print(f"[{index}/{len(docs)}] SKIP {key}: already exists")
                continue
            source = native_source(args.source_dir, document)
            destination = output_dir / f"{production_id}.jpg"
            print(f"[{index}/{len(docs)}] Extracting {source.name} -> {key}")
            extract_frame(source, destination, args.seek_seconds, args.width, args.quality)
            if client:
                upload_thumbnail(client, destination, key)
                if args.output_dir is None:
                    destination.unlink(missing_ok=True)
            completed += 1
        except Exception as error:
            failed += 1
            print(f"[{index}/{len(docs)}] ERROR {key}: {error}", file=sys.stderr)

    print(f"Done: {completed} generated, {skipped} skipped, {failed} failed")
    return 1 if failed else 0


def main():
    args = parse_args()
    if args.width < 64 or not 1 <= args.quality <= 100 or args.seek_seconds < 0:
        raise SystemExit("invalid width, quality, or seek time")
    load_dotenv(PROJECT_DIR / ".env")
    Gst.init(None)
    if args.output_dir:
        return process(args, args.output_dir.resolve())
    with tempfile.TemporaryDirectory(prefix="epstein-video-thumbs-") as temp_dir:
        return process(args, Path(temp_dir))


if __name__ == "__main__":
    raise SystemExit(main())
