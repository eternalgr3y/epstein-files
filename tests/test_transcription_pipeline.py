import math
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import transcription_pipeline
from models import (
    Document,
    DocumentText,
    ProcessingLog,
    create_tables,
    get_engine,
    get_session,
)
from transcription_pipeline import (
    FasterWhisperTranscriber,
    MediaProbe,
    TranscriptionResult,
    get_transcription_stats,
    probe_media,
    process_media_batch,
    pending_media_documents,
    resolve_media_path,
    save_transcription_result,
    segment_confidence,
)


class TranscriptionPipelineTests(unittest.TestCase):
    def test_segment_confidence_is_duration_weighted(self):
        segments = [
            SimpleNamespace(start=0, end=1, avg_logprob=math.log(0.5)),
            SimpleNamespace(start=1, end=4, avg_logprob=math.log(0.9)),
        ]
        self.assertAlmostEqual(segment_confidence(segments), 0.8)

    def test_transcriber_passes_an_explicit_cpu_thread_count(self):
        whisper_model = MagicMock()
        fake_module = SimpleNamespace(WhisperModel=whisper_model)
        with patch.dict(sys.modules, {"faster_whisper": fake_module}):
            FasterWhisperTranscriber(
                model="small.en",
                device="cpu",
                compute_type="int8",
                cpu_threads=3,
            )
        whisper_model.assert_called_once_with(
            "small.en",
            device="cpu",
            compute_type="int8",
            cpu_threads=3,
        )

    def test_resolve_media_path_falls_back_to_original_native_tree(self):
        with tempfile.TemporaryDirectory(prefix="epstein-media-tests-") as temp_dir:
            source = Path(temp_dir)
            native = source / "VOL00001" / "NATIVES" / "NATIVE001"
            native.mkdir(parents=True)
            expected = native / "DOJ-OGR-00000001.WAV"
            expected.touch()
            doc = SimpleNamespace(local_path="/missing/DOJ-OGR-00000001.wav")
            self.assertEqual(resolve_media_path(doc, source), expected)

    def test_probe_media_identifies_an_audio_stream(self):
        with tempfile.TemporaryDirectory(prefix="epstein-media-probe-") as temp_dir:
            path = Path(temp_dir) / "tone.wav"
            subprocess.run(
                [
                    "ffmpeg",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=1000:duration=0.1",
                    str(path),
                ],
                check=True,
            )
            probe = probe_media(path)
            self.assertTrue(probe.has_audio)
            self.assertGreater(probe.duration_seconds, 0)
            self.assertIsNone(probe.error)

    def test_failed_reprocess_preserves_the_last_good_transcript(self):
        with tempfile.TemporaryDirectory(prefix="epstein-transcript-save-") as temp_dir:
            engine = get_engine(str(Path(temp_dir) / "test.db"))
            create_tables(engine)
            session = get_session(engine)
            doc = Document(
                filename="recording.wav",
                local_path="/missing/recording.wav",
                document_type="audio",
                has_text=True,
                ocr_confidence=0.8,
            )
            session.add(doc)
            session.flush()
            session.add(
                DocumentText(
                    document_id=doc.id,
                    full_text="last good transcript",
                    pages_text=["last good transcript"],
                    word_count=3,
                    average_confidence=0.8,
                    ocr_engine="faster-whisper:small.en",
                )
            )
            session.commit()

            save_transcription_result(
                session,
                doc,
                TranscriptionResult(
                    success=False,
                    full_text="",
                    error="temporary decoder failure",
                ),
            )

            session.refresh(doc)
            text_record = session.query(DocumentText).filter_by(document_id=doc.id).one()
            self.assertTrue(doc.has_text)
            self.assertEqual(doc.ocr_confidence, 0.8)
            self.assertEqual(text_record.full_text, "last good transcript")
            session.close()

    def test_stats_do_not_count_recovered_failures_as_current_failures(self):
        with tempfile.TemporaryDirectory(prefix="epstein-transcript-stats-") as temp_dir:
            engine = get_engine(str(Path(temp_dir) / "test.db"))
            create_tables(engine)
            session = get_session(engine)
            recovered = Document(
                filename="recovered.wav",
                local_path="/missing/recovered.wav",
                document_type="audio",
            )
            failed = Document(
                filename="failed.wav",
                local_path="/missing/failed.wav",
                document_type="audio",
            )
            session.add_all([recovered, failed])
            session.flush()
            session.add_all(
                [
                    ProcessingLog(
                        document_id=recovered.id,
                        action="transcription",
                        status="failed",
                    ),
                    ProcessingLog(
                        document_id=recovered.id,
                        action="transcription",
                        status="success",
                    ),
                    ProcessingLog(
                        document_id=failed.id,
                        action="transcription",
                        status="failed",
                    ),
                ]
            )
            session.commit()
            session.close()

            with patch("transcription_pipeline.get_engine", return_value=engine):
                stats = get_transcription_stats()
            self.assertEqual(stats["completed"], 1)
            self.assertEqual(stats["failed"], 1)
            self.assertEqual(stats["remaining"], 1)

    def test_stats_treat_a_later_reprocess_failure_as_current(self):
        with tempfile.TemporaryDirectory(prefix="epstein-transcript-latest-") as temp_dir:
            engine = get_engine(str(Path(temp_dir) / "test.db"))
            create_tables(engine)
            session = get_session(engine)
            document = Document(
                filename="recording.wav",
                local_path="/missing/recording.wav",
                document_type="audio",
            )
            session.add(document)
            session.flush()
            session.add_all(
                [
                    ProcessingLog(
                        document_id=document.id,
                        action="transcription",
                        status="success",
                    ),
                    ProcessingLog(
                        document_id=document.id,
                        action="transcription",
                        status="failed",
                    ),
                ]
            )
            session.commit()
            session.close()

            with patch("transcription_pipeline.get_engine", return_value=engine):
                stats = get_transcription_stats()
            self.assertEqual(stats["completed"], 0)
            self.assertEqual(stats["failed"], 1)
            self.assertEqual(stats["remaining"], 1)

    def test_empty_and_no_audio_batches_do_not_load_whisper(self):
        session = MagicMock()
        with (
            patch("transcription_pipeline.get_engine"),
            patch("transcription_pipeline.get_session", return_value=session),
            patch("transcription_pipeline.pending_media_documents", return_value=[]),
            patch("transcription_pipeline.FasterWhisperTranscriber") as transcriber,
        ):
            self.assertEqual(
                process_media_batch(),
                {"processed": 0, "succeeded": 0, "failed": 0},
            )
            transcriber.assert_not_called()

        doc = SimpleNamespace(id=1, filename="silent.mp4")
        session = MagicMock()
        with (
            patch("transcription_pipeline.get_engine"),
            patch("transcription_pipeline.get_session", return_value=session),
            patch(
                "transcription_pipeline.pending_media_documents", return_value=[doc]
            ),
            patch("transcription_pipeline.resolve_media_path", return_value=Path("x")),
            patch(
                "transcription_pipeline.probe_media",
                return_value=MediaProbe(duration_seconds=10, has_audio=False),
            ),
            patch("transcription_pipeline.save_transcription_result"),
            patch("transcription_pipeline.FasterWhisperTranscriber") as transcriber,
        ):
            self.assertEqual(process_media_batch()["succeeded"], 1)
            transcriber.assert_not_called()

        session = MagicMock()
        transcript = TranscriptionResult(success=True, full_text="short transcript")
        with (
            patch("transcription_pipeline.get_engine"),
            patch("transcription_pipeline.get_session", return_value=session),
            patch(
                "transcription_pipeline.pending_media_documents", return_value=[doc]
            ),
            patch("transcription_pipeline.resolve_media_path", return_value=Path("x")),
            patch(
                "transcription_pipeline.probe_media",
                return_value=MediaProbe(duration_seconds=10, has_audio=True),
            ),
            patch("transcription_pipeline.save_transcription_result"),
            patch("transcription_pipeline.FasterWhisperTranscriber") as transcriber,
        ):
            transcriber.return_value.transcribe.return_value = transcript
            self.assertEqual(process_media_batch(cpu_threads=3)["succeeded"], 1)
            transcriber.assert_called_once_with(
                model="small",
                device="auto",
                compute_type="int8",
                cpu_threads=3,
            )

    def test_pending_documents_can_be_split_into_disjoint_shards(self):
        with tempfile.TemporaryDirectory(prefix="epstein-transcript-shards-") as temp_dir:
            engine = get_engine(str(Path(temp_dir) / "test.db"))
            create_tables(engine)
            session = get_session(engine)
            for number in range(6):
                session.add(
                    Document(
                        filename=f"recording-{number}.wav",
                        local_path=f"/missing/recording-{number}.wav",
                        document_type="audio",
                        file_size=number,
                    )
                )
            session.commit()

            first = pending_media_documents(
                session, limit=10, shard_index=0, shard_count=2
            )
            second = pending_media_documents(
                session, limit=10, shard_index=1, shard_count=2
            )
            first_ids = {doc.id for doc in first}
            second_ids = {doc.id for doc in second}
            self.assertFalse(first_ids & second_ids)
            self.assertEqual(len(first_ids | second_ids), 6)
            session.close()

    def test_inference_does_not_hold_the_selection_transaction_open(self):
        document = SimpleNamespace(id=7, filename="recording.wav")
        selection_session = MagicMock()
        write_session = MagicMock()
        write_session.get.return_value = document

        def transcribe(*_args, **_kwargs):
            self.assertTrue(selection_session.close.called)
            return TranscriptionResult(success=True, full_text="searchable words")

        with (
            patch("transcription_pipeline.get_engine"),
            patch(
                "transcription_pipeline.get_session",
                side_effect=[selection_session, write_session],
            ),
            patch(
                "transcription_pipeline.pending_media_documents",
                return_value=[document],
            ),
            patch("transcription_pipeline.resolve_media_path", return_value=Path("x")),
            patch(
                "transcription_pipeline.probe_media",
                return_value=MediaProbe(duration_seconds=10, has_audio=True),
            ),
            patch("transcription_pipeline.save_transcription_result"),
            patch("transcription_pipeline.FasterWhisperTranscriber") as model,
        ):
            model.return_value.transcribe.side_effect = transcribe
            result = process_media_batch()

        self.assertEqual(result["succeeded"], 1)
        selection_session.expunge_all.assert_called_once()
        write_session.get.assert_called_once_with(Document, 7)
        write_session.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
