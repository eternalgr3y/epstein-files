#!/usr/bin/env python3
"""Create and score a reviewed OCR reference sample."""

import argparse
from collections import Counter
import json
import random
import sqlite3
from pathlib import Path

import fitz

from src.config import DATABASE_PATH, PROCESSED_DIR


CONFIDENCE_BANDS = (
    ("under-0.50", 0.0, 0.50),
    ("0.50-0.69", 0.50, 0.70),
    ("0.70-0.79", 0.70, 0.80),
    ("0.80-0.89", 0.80, 0.90),
    ("0.90-plus", 0.90, 1.01),
)


def edit_distance(reference, hypothesis):
    """Exact bit-parallel Levenshtein distance for characters or word tokens."""
    if len(reference) < len(hypothesis):
        reference, hypothesis = hypothesis, reference
    pattern_length = len(hypothesis)
    if not pattern_length:
        return len(reference)

    positions = {}
    for index, item in enumerate(hypothesis):
        positions[item] = positions.get(item, 0) | (1 << index)

    positive = (1 << pattern_length) - 1
    negative = 0
    distance = pattern_length
    final_bit = 1 << (pattern_length - 1)

    for item in reference:
        matches = positions.get(item, 0)
        combined = matches | negative
        difference = (((matches & positive) + positive) ^ positive) | matches
        horizontal_positive = negative | ~(difference | positive)
        horizontal_negative = positive & difference

        if horizontal_positive & final_bit:
            distance += 1
        elif horizontal_negative & final_bit:
            distance -= 1

        horizontal_positive = (horizontal_positive << 1) | 1
        horizontal_negative <<= 1
        positive = horizontal_negative | ~(combined | horizontal_positive)
        negative = horizontal_positive & combined

    return distance


def normalize_text(value):
    return " ".join((value or "").split())


def score_pair(reference, hypothesis):
    reference = normalize_text(reference)
    hypothesis = normalize_text(hypothesis)
    character_errors = edit_distance(reference, hypothesis)
    reference_words = reference.split()
    hypothesis_words = hypothesis.split()
    word_errors = edit_distance(reference_words, hypothesis_words)
    return {
        "character_errors": character_errors,
        "reference_characters": len(reference),
        "cer": character_errors / max(len(reference), 1),
        "word_errors": word_errors,
        "reference_words": len(reference_words),
        "wer": word_errors / max(len(reference_words), 1),
    }


SCORE_TOTAL_KEYS = (
    "character_errors",
    "reference_characters",
    "word_errors",
    "reference_words",
)


def _empty_aggregate():
    return {
        "pages": 0,
        "character_errors": 0,
        "reference_characters": 0,
        "word_errors": 0,
        "reference_words": 0,
    }


def _add_score(aggregate, score):
    aggregate["pages"] += 1
    for key in SCORE_TOTAL_KEYS:
        aggregate[key] += score[key]


def _finalize_aggregate(aggregate):
    result = dict(aggregate)
    result["cer"] = result["character_errors"] / max(
        result["reference_characters"], 1
    )
    result["wer"] = result["word_errors"] / max(
        result["reference_words"], 1
    )
    return result


def render_review_page(source_path, page_number, output_path, dpi):
    """Render a manifest page for side-by-side reference transcription."""
    try:
        with fitz.open(source_path) as document:
            page = document.load_page(page_number - 1)
            pixmap = page.get_pixmap(dpi=dpi, alpha=False)
            pixmap.save(output_path)
        return str(output_path)
    except Exception:
        return None


def create_sample(database, output, per_band, seed, force=False, render_dpi=300):
    if output.exists() and not force:
        raise FileExistsError(f"{output} already exists; pass --force to replace it")

    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        """
        SELECT d.id AS document_id, d.filename, d.local_path, d.page_count,
               t.average_confidence
        FROM documents d
        JOIN document_texts t ON t.document_id = d.id
        WHERE d.content_type = 'application/pdf' AND d.page_count > 0
        """
    ).fetchall()
    connection.close()

    rng = random.Random(seed)
    selected = []
    for label, lower, upper in CONFIDENCE_BANDS:
        candidates = [
            row
            for row in rows
            if row["average_confidence"] is not None
            and lower <= row["average_confidence"] < upper
        ]
        rng.shuffle(candidates)
        for row in candidates[:per_band]:
            page_number = rng.randint(1, row["page_count"])
            selected.append((label, row, page_number))

    output.parent.mkdir(parents=True, exist_ok=True)
    truth_dir = output.parent / "ground-truth"
    truth_dir.mkdir(exist_ok=True)
    review_dir = output.parent / "review-pages"
    review_dir.mkdir(exist_ok=True)

    with output.open("w", encoding="utf-8") as manifest:
        for label, row, page_number in selected:
            truth_path = truth_dir / f"{row['document_id']}-p{page_number}.txt"
            truth_path.touch(exist_ok=True)
            review_path = review_dir / f"{row['document_id']}-p{page_number}.png"
            rendered = render_review_page(
                row["local_path"], page_number, review_path, render_dpi
            )
            manifest.write(
                json.dumps(
                    {
                        "document_id": row["document_id"],
                        "filename": row["filename"],
                        "source_path": row["local_path"],
                        "page_number": page_number,
                        "confidence": row["average_confidence"],
                        "confidence_band": label,
                        "ground_truth_path": str(truth_path),
                        "review_image_path": rendered,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    return len(selected)


def evaluate_manifest(database, manifest_path):
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    aggregate = _empty_aggregate()
    band_aggregates = {}
    page_results = []
    skipped = Counter()

    with manifest_path.open(encoding="utf-8") as manifest:
        for line in manifest:
            entry = json.loads(line)
            truth_path = Path(entry["ground_truth_path"])
            if not truth_path.exists() or not truth_path.read_text(encoding="utf-8").strip():
                skipped["missing_or_empty_reference"] += 1
                continue
            row = connection.execute(
                "SELECT pages_text FROM document_texts WHERE document_id = ?",
                (entry["document_id"],),
            ).fetchone()
            if not row:
                skipped["missing_document_text"] += 1
                continue
            pages = json.loads(row["pages_text"])
            page_index = entry["page_number"] - 1
            if not 0 <= page_index < len(pages):
                skipped["page_out_of_range"] += 1
                continue
            score = score_pair(
                truth_path.read_text(encoding="utf-8"),
                pages[page_index],
            )
            _add_score(aggregate, score)
            band = entry["confidence_band"]
            _add_score(band_aggregates.setdefault(band, _empty_aggregate()), score)
            page_results.append(
                {
                    "document_id": entry["document_id"],
                    "page_number": entry["page_number"],
                    "confidence": entry["confidence"],
                    "confidence_band": band,
                    **score,
                }
            )

    connection.close()
    result = _finalize_aggregate(aggregate)
    result["manifest_pages"] = aggregate["pages"] + sum(skipped.values())
    result["skipped_pages"] = sum(skipped.values())
    result["skip_reasons"] = dict(sorted(skipped.items()))
    result["by_confidence_band"] = {
        band: _finalize_aggregate(band_aggregates.get(band, _empty_aggregate()))
        for band, _, _ in CONFIDENCE_BANDS
    }
    result["page_results"] = page_results
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DATABASE_PATH)
    subparsers = parser.add_subparsers(dest="command", required=True)

    sample = subparsers.add_parser("sample", help="Create a stratified labeling set")
    sample.add_argument(
        "--output",
        type=Path,
        default=PROCESSED_DIR / "ocr-gold" / "manifest.jsonl",
    )
    sample.add_argument("--per-band", type=int, default=20)
    sample.add_argument("--seed", type=int, default=20260722)
    sample.add_argument("--render-dpi", type=int, default=300)
    sample.add_argument("--force", action="store_true")

    evaluate = subparsers.add_parser("evaluate", help="Calculate CER and WER")
    evaluate.add_argument("manifest", type=Path)
    evaluate.add_argument(
        "--allow-incomplete",
        action="store_true",
        help="return success when reference labels are missing",
    )
    evaluate.add_argument(
        "--output",
        type=Path,
        help="also write the JSON report to this path",
    )

    args = parser.parse_args()
    if args.command == "sample":
        count = create_sample(
            args.database,
            args.output,
            args.per_band,
            args.seed,
            args.force,
            args.render_dpi,
        )
        print(f"Created {count} review pages in {args.output}")
    else:
        result = evaluate_manifest(args.database, args.manifest)
        rendered = json.dumps(result, indent=2)
        print(rendered)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(rendered + "\n", encoding="utf-8")
        if result["skipped_pages"] and not args.allow_incomplete:
            raise SystemExit(2)


if __name__ == "__main__":
    main()
