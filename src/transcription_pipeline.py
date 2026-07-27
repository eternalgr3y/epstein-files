"""Resumable speech-to-text processing for archive audio and video files."""

import json
import logging
import math
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from sqlalchemy import func

from models import (
    Document, DocumentText, ProcessingLog, ProcessingStatus,
    get_engine, get_session, utc_now,
)
from fts_index import sync_fts_document


logger = logging.getLogger(__name__)

DEFAULT_NATIVE_SOURCE_DIR = (
    Path.home()
    / "epstein-raw"
    / "house-oversight-doj"
    / "Prod 01_ 20250822"
)
MEDIA_TYPES = ("audio", "video")


@dataclass
class TranscriptionResult:
    success: bool
    full_text: str
    language: str = "eng"
    average_confidence: float = 0.0
    duration_seconds: float = 0.0
    engine: str = "faster-whisper"
    error: Optional[str] = None
    duration_ms: int = 0

    @property
    def word_count(self):
        return len(self.full_text.split())


@dataclass
class MediaProbe:
    duration_seconds: float
    has_audio: bool
    error: Optional[str] = None


def probe_media(media_path: Path) -> MediaProbe:
    """Read duration/audio-stream metadata without decoding the full file."""
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type",
            "-of",
            "json",
            str(media_path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return MediaProbe(0.0, False, result.stderr.strip() or "ffprobe failed")
    try:
        data = json.loads(result.stdout)
        duration = float(data.get("format", {}).get("duration") or 0.0)
        has_audio = any(
            stream.get("codec_type") == "audio" for stream in data.get("streams", [])
        )
        return MediaProbe(duration, has_audio)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        return MediaProbe(0.0, False, str(exc))


def segment_confidence(segments) -> float:
    """Convert Whisper average log probabilities to a duration-weighted score."""
    weighted = 0.0
    total_duration = 0.0
    for segment in segments:
        duration = max(float(segment.end) - float(segment.start), 0.01)
        probability = min(max(math.exp(float(segment.avg_logprob)), 0.0), 1.0)
        weighted += probability * duration
        total_duration += duration
    return weighted / total_duration if total_duration else 0.0


class FasterWhisperTranscriber:
    def __init__(
        self,
        model="small",
        device="auto",
        compute_type="int8",
        cpu_threads=0,
    ):
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise RuntimeError(
                "faster-whisper is not installed; run "
                "`python -m pip install --target .transcription-deps "
                "-r requirements-transcription.txt`"
            ) from exc

        self.model_name = model
        self.model = WhisperModel(
            model,
            device=device,
            compute_type=compute_type,
            cpu_threads=cpu_threads,
        )

    def transcribe(self, media_path: Path, language="en") -> TranscriptionResult:
        start = time.time()
        try:
            segments, info = self.model.transcribe(
                str(media_path),
                language=language,
                vad_filter=True,
                beam_size=5,
            )
            segments = list(segments)
            full_text = " ".join(
                segment.text.strip() for segment in segments if segment.text.strip()
            )
            return TranscriptionResult(
                success=True,
                full_text=full_text,
                language=getattr(info, "language", language) or language,
                average_confidence=segment_confidence(segments),
                duration_seconds=float(getattr(info, "duration", 0.0) or 0.0),
                engine=f"faster-whisper:{self.model_name}",
                duration_ms=int((time.time() - start) * 1000),
            )
        except Exception as exc:
            return TranscriptionResult(
                success=False,
                full_text="",
                engine=f"faster-whisper:{self.model_name}",
                error=str(exc),
                duration_ms=int((time.time() - start) * 1000),
            )


def resolve_media_path(doc, native_source_dir: Optional[Path] = None) -> Optional[Path]:
    """Resolve staged media or the original House Oversight native file."""
    staged = Path(doc.local_path)
    if staged.exists():
        return staged

    source_dir = native_source_dir or Path(
        os.getenv("EPSTEIN_NATIVE_SOURCE_DIR", DEFAULT_NATIVE_SOURCE_DIR)
    )
    stem = staged.stem
    matches = sorted(source_dir.glob(f"VOL00001/NATIVES/*/{stem}.*"))
    return matches[0] if matches else None


def pending_media_documents(
    session,
    limit=10,
    reprocess=False,
    shard_index=0,
    shard_count=1,
):
    if shard_count < 1 or not 0 <= shard_index < shard_count:
        raise ValueError("shard_index must be between 0 and shard_count - 1")
    query = session.query(Document).outerjoin(
        DocumentText, Document.id == DocumentText.document_id
    ).filter(
        Document.document_type.in_(MEDIA_TYPES),
    )
    if reprocess:
        query = query.filter(DocumentText.id.is_not(None))
    else:
        query = query.filter(DocumentText.id.is_(None))
        completed = session.query(ProcessingLog.document_id).filter(
            ProcessingLog.action == "transcription",
            ProcessingLog.status == "success",
        )
        query = query.filter(~Document.id.in_(completed))
    if shard_count > 1:
        query = query.filter(Document.id % shard_count == shard_index)
    return query.order_by(Document.file_size.asc(), Document.id.asc()).limit(limit).all()


def get_transcription_stats():
    session = get_session(get_engine())
    try:
        media_ids = session.query(Document.id).filter(Document.document_type.in_(MEDIA_TYPES))
        latest_log_ids = session.query(
            func.max(ProcessingLog.id).label("id")
        ).filter(
            ProcessingLog.action == "transcription"
        ).group_by(ProcessingLog.document_id).subquery()
        latest_logs = session.query(ProcessingLog).filter(
            ProcessingLog.id.in_(session.query(latest_log_ids.c.id))
        )
        transcripts = session.query(DocumentText).join(
            Document, Document.id == DocumentText.document_id
        ).filter(
            Document.document_type.in_(MEDIA_TYPES),
            DocumentText.ocr_engine.like("faster-whisper:%"),
        )
        total = media_ids.count()
        completed = latest_logs.filter(ProcessingLog.status == "success").count()
        return {
            "total_media": total,
            "completed": completed,
            "remaining": max(total - completed, 0),
            "failed": latest_logs.filter(ProcessingLog.status == "failed").count(),
            "searchable_transcripts": transcripts.count(),
            "transcript_words": sum(row.word_count or 0 for row in transcripts.all()),
        }
    finally:
        session.close()


def save_transcription_result(session, doc, result: TranscriptionResult):
    text_record = session.query(DocumentText).filter_by(document_id=doc.id).first()
    doc.processing_status = (
        ProcessingStatus.COMPLETED.value if result.success else ProcessingStatus.FAILED.value
    )
    doc.needs_ocr = False

    if result.success:
        doc.has_text = result.word_count > 0
        doc.ocr_confidence = result.average_confidence
        doc.ocr_completed_at = utc_now()
        if result.word_count > 0:
            if text_record is None:
                text_record = DocumentText(document_id=doc.id)
                session.add(text_record)
            text_record.full_text = result.full_text
            text_record.pages_text = [result.full_text]
            text_record.word_count = result.word_count
            text_record.average_confidence = result.average_confidence
            text_record.ocr_engine = result.engine
            text_record.ocr_language = result.language
        elif text_record is not None:
            session.delete(text_record)
        sync_fts_document(session, doc.id, result.full_text)
    else:
        # A transient reprocessing failure must not erase or hide the last
        # successful transcript. The failure remains visible in status/logs.
        doc.has_text = bool(
            text_record is not None and (text_record.full_text or "").strip()
        )

    session.add(
        ProcessingLog(
            document_id=doc.id,
            action="transcription",
            status="success" if result.success else "failed",
            message=(
                f"Engine: {result.engine}, Words: {result.word_count}, "
                f"Confidence: {result.average_confidence:.2f}, "
                f"Media duration: {result.duration_seconds:.1f}s"
            ),
            error_details=result.error,
            duration_ms=result.duration_ms,
        )
    )
    session.commit()


def process_media_batch(
    limit=10,
    model="small",
    device="auto",
    compute_type="int8",
    language="en",
    dry_run=False,
    reprocess=False,
    shard_index=0,
    shard_count=1,
    cpu_threads=0,
):
    session = get_session(get_engine())
    try:
        documents = pending_media_documents(
            session,
            limit=limit,
            reprocess=reprocess,
            shard_index=shard_index,
            shard_count=shard_count,
        )
        resolved = [(doc, resolve_media_path(doc)) for doc in documents]
        if dry_run:
            probes = [
                probe_media(path)
                for _, path in resolved
                if path is not None
            ]
            return {
                "pending": len(documents),
                "resolved": sum(path is not None for _, path in resolved),
                "missing": [doc.filename for doc, path in resolved if path is None],
                "with_audio": sum(probe.has_audio for probe in probes),
                "without_audio": sum(not probe.has_audio for probe in probes),
                "media_hours": round(
                    sum(probe.duration_seconds for probe in probes) / 3600, 2
                ),
            }

        if not documents:
            return {"processed": 0, "succeeded": 0, "failed": 0}

        # Do not hold a SQLite read transaction open during model inference.
        # Each result is persisted in a short, fresh transaction so disjoint
        # shards cannot hit a stale-snapshot write upgrade.
        session.expunge_all()
        session.close()
        session = None

        transcriber = None
        succeeded = 0
        failed = 0
        for doc, media_path in resolved:
            if media_path is None:
                result = TranscriptionResult(
                    success=False,
                    full_text="",
                    engine=f"faster-whisper:{model}",
                    error="Media source file not found",
                )
            else:
                probe = probe_media(media_path)
                if probe.error:
                    result = TranscriptionResult(
                        success=False,
                        full_text="",
                        engine="ffprobe",
                        error=probe.error,
                    )
                elif not probe.has_audio:
                    result = TranscriptionResult(
                        success=True,
                        full_text="",
                        duration_seconds=probe.duration_seconds,
                        engine="ffprobe:no-audio-stream",
                    )
                else:
                    logger.info("Transcribing %s from %s", doc.filename, media_path)
                    if transcriber is None:
                        transcriber = FasterWhisperTranscriber(
                            model=model,
                            device=device,
                            compute_type=compute_type,
                            cpu_threads=cpu_threads,
                        )
                    result = transcriber.transcribe(media_path, language=language)
            write_session = get_session(get_engine())
            try:
                current_document = write_session.get(Document, doc.id)
                save_transcription_result(write_session, current_document, result)
            finally:
                write_session.close()
            succeeded += int(result.success)
            failed += int(not result.success)
            logger.info(
                "Finished %s: success=%s words=%d confidence=%.2f",
                doc.filename,
                result.success,
                result.word_count,
                result.average_confidence,
            )
        return {"processed": len(documents), "succeeded": succeeded, "failed": failed}
    finally:
        if session is not None:
            session.close()
