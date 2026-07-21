#!/usr/bin/env python3
"""Upload the House Oversight DOJ batch's combined PDFs + native audio/video
files to R2, at the key implied by each Document.local_path (everything after
"epstein-files/" — see worker.js's file-serving regex).

Resumable: successful uploads are logged to UPLOADED_LOG, and already-logged
keys are skipped on rerun (checking R2 itself for existence would also work
but is much slower than a local log for ~1,650 files).
"""
import re
import subprocess
import sys
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(Path(__file__).parent / 'src'))
from models import get_engine, get_session, Document

BUCKET = "epstein-files"
WORKERS = 4
UPLOADED_LOG = Path("/tmp/doj_r2_uploaded.log")
NODE = Path.home() / ".local" / "node-v22.23.1" / "bin" / "node"
WRANGLER = Path(__file__).parent / "node_modules" / ".bin" / "wrangler"

NATIVE_SOURCE_DIR = Path.home() / "epstein-raw" / "house-oversight-doj" / "Prod 01_ 20250822"


def r2_key_from_local_path(local_path: str):
    m = re.search(r'epstein-files/(.+)$', local_path)
    return m.group(1) if m else None


def upload_one(key: str, src_path: Path, content_type: str):
    result = subprocess.run(
        [
            str(NODE), str(WRANGLER), "r2", "object", "put",
            f"{BUCKET}/{key}",
            "--file", str(src_path),
            "--content-type", content_type,
            "--remote",
        ],
        capture_output=True, text=True, timeout=3600,
    )
    if result.returncode != 0:
        return key, f"failed: {result.stderr[-300:]}"
    return key, "ok"


def main():
    engine = get_engine()
    session = get_session(engine)
    docs = session.query(Document).filter_by(data_set='house-oversight-doj').all()
    session.close()

    already = set()
    if UPLOADED_LOG.exists():
        already = set(UPLOADED_LOG.read_text().splitlines())

    jobs = []
    for doc in docs:
        key = r2_key_from_local_path(doc.local_path)
        if not key or key in already:
            continue
        if doc.document_type == 'pdf':
            src = Path(doc.local_path)
        else:
            # Native files were never physically staged under the project's
            # raw/ tree — upload straight from the original download location.
            # The NATIVE folder number isn't encoded in local_path, so resolve by glob.
            matches = list(NATIVE_SOURCE_DIR.glob(f"VOL00001/NATIVES/*/{Path(doc.local_path).stem}.*"))
            if not matches:
                print(f"SKIP {key}: native source not found")
                continue
            src = matches[0]
        if not src.exists():
            print(f"SKIP {key}: source missing: {src}")
            continue
        jobs.append((key, src, doc.content_type or 'application/octet-stream'))

    total = len(jobs)
    print(f"{len(already)} already uploaded, {total} remaining")
    if total == 0:
        return

    done = 0
    errors = []
    start = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(upload_one, key, src, ct): key for key, src, ct in jobs}
        with open(UPLOADED_LOG, 'a') as logf:
            for fut in as_completed(futures):
                key, status = fut.result()
                done += 1
                if status == "ok":
                    logf.write(key + "\n")
                    logf.flush()
                else:
                    errors.append((key, status))
                    print(f"  ERROR {key}: {status}")
                if done % 20 == 0 or done == total:
                    elapsed = time.time() - start
                    print(f"[{done}/{total}] {len(errors)} errors, {elapsed/60:.1f}m elapsed")

    print(f"\nDone. {done - len(errors)} succeeded, {len(errors)} failed.")
    if errors:
        print("Failures:")
        for k, s in errors[:30]:
            print(f"  {k}: {s}")


if __name__ == "__main__":
    main()
