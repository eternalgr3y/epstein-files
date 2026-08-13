#!/usr/bin/env python3
"""Re-OCR documents that have no stored text, straight from R2 via the API.

Why this is standalone rather than reusing src/ocr_pipeline.py:

  * ocr_pipeline.py drives the local SQLite database (database/epstein_files.db),
    which is from 22 Jul and no longer matches production D1.
  * The originals it expects under /mnt/e/... are on a drive that is not on
    this machine. R2 is now the only source, reachable through
    /api/documents/<id>/file (protected by the Worker's dedicated media rate
    limiter and publication-exclusion checks).
  * ocr_pipeline.py currently carries ~300 lines of uncommitted changes. This
    script deliberately does not depend on that in-progress work.

Results land in a local SQLite state file so the run is resumable: documents
already marked done are skipped, so a suspend, a crash, or a Ctrl-C costs at
most the documents in flight. Nothing is written to D1 here -- use
export_ocr_sql.py to turn the state file into an import.

Usage:
    python3 ocr_backfill.py --limit 50           # pilot
    python3 ocr_backfill.py                      # everything outstanding
    python3 ocr_backfill.py --workers 6 --dpi 300

Run the full job under systemd-inhibit so the laptop does not suspend
mid-document:
    systemd-inhibit --what=idle:sleep --why="OCR backfill" \
        python3 ocr_backfill.py
"""

import argparse
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

API = "https://epsteinproject.org/api"
STATE_DB = Path(__file__).parent / "ocr_backfill_state.db"

# Cloudflare 403s the default python-urllib User-Agent.
UA = "epstein-files-ocr-backfill/1.0 (+https://epsteinproject.org)"


def _open(url, timeout):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout
    )

# Render/OCR a few pages at a time: a 100-page PDF at 300 DPI is ~130 MB of
# PNGs, which is fine transiently but not worth holding all at once.
PAGE_BATCH = 10

log = logging.getLogger("ocr_backfill")


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------

def init_state(path=STATE_DB):
    conn = sqlite3.connect(path, timeout=60)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ocr_result (
            document_id INTEGER PRIMARY KEY,
            filename    TEXT,
            status      TEXT NOT NULL,   -- done | empty | failed
            full_text   TEXT,
            confidence  REAL,
            page_count  INTEGER,
            error       TEXT,
            seconds     REAL,
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """
    )
    conn.commit()
    return conn


def already_processed(conn):
    """Document ids we never need to look at again."""
    rows = conn.execute(
        "SELECT document_id FROM ocr_result WHERE status IN ('done', 'empty')"
    ).fetchall()
    return {r[0] for r in rows}


# --------------------------------------------------------------------------
# Worklist
# --------------------------------------------------------------------------

def fetch_worklist(limit=None):
    """Ask the API which PDFs still have no stored text.

    has_text is derived server-side from document_texts, so this list is the
    real outstanding set rather than the (unreliable) documents.has_text flag.
    """
    out, offset, page = [], 0, 100
    while True:
        url = f"{API}/browse?has_text=0&document_type=pdf&limit={page}&offset={offset}"
        with _open(url, timeout=60) as resp:
            data = json.load(resp)
        results = data.get("results") or []
        if not results:
            break
        out.extend((r["document_id"], r.get("filename") or "") for r in results)
        if limit and len(out) >= limit:
            return out[:limit]
        offset += page
        if offset >= (data.get("total") or 0):
            break
    return out


# --------------------------------------------------------------------------
# OCR
# --------------------------------------------------------------------------

def _page_count(pdf):
    try:
        out = subprocess.run(
            ["pdfinfo", str(pdf)], capture_output=True, text=True, timeout=120
        ).stdout
        for line in out.splitlines():
            if line.lower().startswith("pages:"):
                return int(line.split()[-1])
    except Exception:
        pass
    return 0


def _ocr_image(png):
    """Return (text, mean_confidence) for one rendered page.

    Uses tesseract's TSV output so text and per-word confidence come from a
    single invocation instead of running tesseract twice.
    """
    proc = subprocess.run(
        ["tesseract", str(png), "stdout", "tsv"],
        capture_output=True, text=True, timeout=300,
    )
    words, confs = [], []
    for line in proc.stdout.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) < 12:
            continue
        text, conf = parts[11].strip(), parts[10]
        if not text:
            continue
        words.append(text)
        try:
            c = float(conf)
            if c >= 0:
                confs.append(c)
        except ValueError:
            pass
    mean_conf = (sum(confs) / len(confs) / 100.0) if confs else 0.0
    return " ".join(words), mean_conf


def ocr_document(doc_id, filename, dpi):
    """Download one PDF, OCR every page, return a result row."""
    started = time.time()
    workdir = Path(tempfile.mkdtemp(prefix=f"ocr{doc_id}_"))
    try:
        pdf = workdir / "src.pdf"
        with _open(f"{API}/documents/{doc_id}/file", timeout=300) as resp:
            with pdf.open("wb") as fh:
                shutil.copyfileobj(resp, fh)

        pages = _page_count(pdf)
        if not pages:
            return dict(document_id=doc_id, filename=filename, status="failed",
                        error="unreadable or zero-page PDF",
                        seconds=time.time() - started)

        texts, confs = [], []
        for first in range(1, pages + 1, PAGE_BATCH):
            last = min(first + PAGE_BATCH - 1, pages)
            subprocess.run(
                ["pdftoppm", "-r", str(dpi), "-f", str(first), "-l", str(last),
                 "-png", str(pdf), str(workdir / "pg")],
                capture_output=True, timeout=1800, check=False,
            )
            for png in sorted(workdir.glob("pg*.png")):
                text, conf = _ocr_image(png)
                if text:
                    texts.append(text)
                    confs.append(conf)
                png.unlink(missing_ok=True)

        full = "\n".join(texts).strip()
        mean_conf = (sum(confs) / len(confs)) if confs else 0.0
        # An image-only scan legitimately yields nothing. Record it as 'empty'
        # so it is not retried forever, but keep it distinct from a failure.
        status = "done" if full else "empty"
        return dict(document_id=doc_id, filename=filename, status=status,
                    full_text=full, confidence=round(mean_conf, 4),
                    page_count=pages, seconds=round(time.time() - started, 1))
    except Exception as exc:  # noqa: BLE001 - any failure is per-document
        return dict(document_id=doc_id, filename=filename, status="failed",
                    error=f"{type(exc).__name__}: {exc}",
                    seconds=round(time.time() - started, 1))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def save(conn, row):
    conn.execute(
        """
        INSERT INTO ocr_result
            (document_id, filename, status, full_text, confidence,
             page_count, error, seconds, updated_at)
        VALUES (?,?,?,?,?,?,?,?, datetime('now'))
        ON CONFLICT(document_id) DO UPDATE SET
            status=excluded.status, full_text=excluded.full_text,
            confidence=excluded.confidence, page_count=excluded.page_count,
            error=excluded.error, seconds=excluded.seconds,
            updated_at=excluded.updated_at
        """,
        (row["document_id"], row.get("filename"), row["status"],
         row.get("full_text"), row.get("confidence"), row.get("page_count"),
         row.get("error"), row.get("seconds")),
    )
    conn.commit()


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, help="only process N documents (pilot runs)")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--retry-failed", action="store_true",
                    help="also retry documents previously marked failed")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s",
                        datefmt="%H:%M:%S")

    for tool in ("pdftoppm", "pdfinfo", "tesseract"):
        if not shutil.which(tool):
            sys.exit(f"required tool not found on PATH: {tool}")

    conn = init_state()
    done = already_processed(conn)
    if not args.retry_failed:
        done |= {r[0] for r in conn.execute(
            "SELECT document_id FROM ocr_result WHERE status='failed'").fetchall()}

    log.info("fetching worklist from %s ...", API)
    work = [(d, f) for d, f in fetch_worklist(args.limit) if d not in done]
    if not work:
        log.info("nothing to do (%d already processed)", len(done))
        return
    log.info("%d documents to OCR  |  %d workers  |  %d DPI  |  %d already done",
             len(work), args.workers, args.dpi, len(done))

    counts = {"done": 0, "empty": 0, "failed": 0}
    started = time.time()

    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(ocr_document, d, f, args.dpi): d for d, f in work}
        for n, fut in enumerate(as_completed(futures), 1):
            row = fut.result()
            save(conn, row)
            counts[row["status"]] = counts.get(row["status"], 0) + 1
            rate = (time.time() - started) / n
            log.info(
                "[%d/%d] doc %s %s (%s pages, conf %.2f, %.0fs) | eta %.0f min",
                n, len(work), row["document_id"], row["status"],
                row.get("page_count") or "?", row.get("confidence") or 0.0,
                row.get("seconds") or 0, (len(work) - n) * rate / 60,
            )

    log.info("finished in %.1f min -- %s", (time.time() - started) / 60, counts)
    log.info("state: %s   next: python3 export_ocr_sql.py", STATE_DB)


if __name__ == "__main__":
    main()
