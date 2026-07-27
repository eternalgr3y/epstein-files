#!/usr/bin/env python3
"""Transcribe pending archive audio/video documents into searchable text."""

import argparse
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).parent
LOCAL_DEPENDENCIES = ROOT / ".transcription-deps"
if LOCAL_DEPENDENCIES.exists():
    sys.path.insert(0, str(LOCAL_DEPENDENCIES))
sys.path.insert(0, str(ROOT / "src"))

from transcription_pipeline import get_transcription_stats, process_media_batch


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument(
        "--cpu-threads",
        type=int,
        default=0,
        help="CTranslate2 CPU threads per worker (0 uses its default)",
    )
    parser.add_argument("--language", default="en")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--reprocess", action="store_true")
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    if args.status:
        print(json.dumps(get_transcription_stats(), indent=2))
        return
    result = process_media_batch(
        limit=args.limit,
        model=args.model,
        device=args.device,
        compute_type=args.compute_type,
        language=args.language,
        dry_run=args.dry_run,
        reprocess=args.reprocess,
        shard_index=args.shard_index,
        shard_count=args.shard_count,
        cpu_threads=args.cpu_threads,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
