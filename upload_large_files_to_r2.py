#!/usr/bin/env python3
"""Upload the handful of House Oversight DOJ files that exceed wrangler CLI's
300MiB limit (large combined PDFs + native videos, up to ~20GB), via R2's
S3-compatible API with boto3's automatic multipart upload.

Reuses the same key-resolution logic as upload_house_oversight_doj_to_r2.py.
"""
import os
import re
import sys
import time
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.exceptions import ClientError
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent / 'src'))
from models import get_engine, get_session, Document

BUCKET = "epstein-files"
NATIVE_SOURCE_DIR = Path.home() / "epstein-raw" / "house-oversight-doj" / "Prod 01_ 20250822"
SIZE_THRESHOLD = 300 * 1024 * 1024  # wrangler CLI's cutoff
UPLOADED_LOG = Path("/tmp/doj_r2_uploaded.log")

load_dotenv(Path(__file__).parent / ".env")


def r2_key_from_local_path(local_path: str):
    m = re.search(r'epstein-files/(.+)$', local_path)
    return m.group(1) if m else None


def resolve_source(doc, key):
    if doc.document_type == 'pdf':
        return Path(doc.local_path)
    matches = list(NATIVE_SOURCE_DIR.glob(f"VOL00001/NATIVES/*/{Path(doc.local_path).stem}.*"))
    return matches[0] if matches else None


def main():
    s3 = boto3.client(
        's3',
        endpoint_url=os.environ['R2_ENDPOINT_URL'],
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto',
    )
    transfer_config = TransferConfig(
        multipart_threshold=64 * 1024 * 1024,
        multipart_chunksize=64 * 1024 * 1024,
        max_concurrency=4,
    )

    engine = get_engine()
    session = get_session(engine)
    docs = session.query(Document).filter_by(data_set='house-oversight-doj').all()
    session.close()

    already = set(UPLOADED_LOG.read_text().splitlines()) if UPLOADED_LOG.exists() else set()
    jobs = []
    for doc in docs:
        key = r2_key_from_local_path(doc.local_path)
        if not key or key in already:
            continue
        src = resolve_source(doc, key)
        if not src or not src.exists():
            continue
        if src.stat().st_size < SIZE_THRESHOLD:
            continue  # already handled by the CLI batch
        try:
            remote = s3.head_object(Bucket=BUCKET, Key=key)
            if remote['ContentLength'] == src.stat().st_size:
                if key not in already:
                    with UPLOADED_LOG.open("a") as log_file:
                        log_file.write(key + "\n")
                    already.add(key)
                continue
        except ClientError:
            pass
        jobs.append((key, src))

    print(f"{len(jobs)} large files to upload")

    def progress_for(size, key):
        state = {'uploaded': 0, 'start': time.time()}
        def cb(bytes_amount):
            state['uploaded'] += bytes_amount
            pct = state['uploaded'] / size * 100
            elapsed = time.time() - state['start']
            mbps = (state['uploaded'] / 1024 / 1024) / elapsed if elapsed > 0 else 0
            if state['uploaded'] >= size or int(pct) % 10 == 0:
                print(f"  {key}: {pct:.0f}% ({state['uploaded']/1024/1024:.0f}/{size/1024/1024:.0f} MB, {mbps:.1f} MB/s)")
        return cb

    for i, (key, src) in enumerate(jobs, 1):
        size = src.stat().st_size
        content_type = 'application/pdf' if src.suffix.lower() == '.pdf' else (
            'video/mp4' if src.suffix.lower() == '.mp4' else 'audio/wav'
        )
        print(f"[{i}/{len(jobs)}] Uploading {key} ({size/1024/1024/1024:.2f} GB)...")
        t0 = time.time()
        try:
            s3.upload_file(
                str(src), BUCKET, key,
                ExtraArgs={'ContentType': content_type},
                Config=transfer_config,
                Callback=progress_for(size, key),
            )
            with UPLOADED_LOG.open("a") as log_file:
                log_file.write(key + "\n")
            print(f"  done in {(time.time()-t0)/60:.1f}m")
        except Exception as e:
            print(f"  FAILED: {e}")

    print("All large files processed.")


if __name__ == "__main__":
    main()
