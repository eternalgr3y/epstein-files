"""
Generate thumbnails for video files using ffmpeg.
Extracts a frame from each video and saves as JPEG.
"""

import subprocess
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(Path(__file__).parent))
from config import THUMBNAIL_DIR, EXTRACTED_DIR
from models import get_engine, get_session, Document


def generate_thumbnail(video_path: Path, output_path: Path, timestamp: str = "00:00:02") -> bool:
    """
    Extract a frame from video at given timestamp.
    Returns True on success, False on failure.
    """
    if output_path.exists():
        return True  # Already generated

    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        # ffmpeg: seek to timestamp, extract 1 frame, scale to 320px wide (maintain aspect)
        cmd = [
            "ffmpeg", "-y",
            "-ss", timestamp,
            "-i", str(video_path),
            "-vframes", "1",
            "-vf", "scale=320:-1",
            "-q:v", "3",  # JPEG quality (2-31, lower is better)
            str(output_path)
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=30
        )

        return output_path.exists()

    except subprocess.TimeoutExpired:
        print(f"  Timeout: {video_path.name}")
        return False
    except Exception as e:
        print(f"  Error: {video_path.name}: {e}")
        return False


def find_video_file(filename: str, data_set: str) -> Path | None:
    """Find the actual video file in extracted directory."""
    # Convert data_set to directory name (e.g., "Data Set 8" -> "data-set-8")
    ds_dir = data_set.lower().replace(" ", "-")

    # Search in extracted directory
    search_path = EXTRACTED_DIR / ds_dir
    if search_path.exists():
        matches = list(search_path.rglob(filename))
        if matches:
            return matches[0]

    # Fallback: search entire extracted dir
    matches = list(EXTRACTED_DIR.rglob(filename))
    if matches:
        return matches[0]

    return None


def main():
    engine = get_engine()
    session = get_session(engine)

    try:
        # Get all video documents
        videos = session.query(Document).filter(Document.document_type == "video").all()
        print(f"Found {len(videos)} videos in database")

        # Build list of (doc_id, video_path, thumbnail_path)
        tasks = []
        for doc in videos:
            video_path = find_video_file(doc.filename, doc.data_set or "")
            if video_path:
                thumb_path = THUMBNAIL_DIR / f"{doc.id}.jpg"
                tasks.append((doc.id, video_path, thumb_path))
            else:
                print(f"  Not found: {doc.filename}")

        print(f"Generating thumbnails for {len(tasks)} videos...")

        success = 0
        failed = 0

        # Process with thread pool (I/O bound)
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {
                executor.submit(generate_thumbnail, vp, tp): (doc_id, vp)
                for doc_id, vp, tp in tasks
            }

            for i, future in enumerate(as_completed(futures), 1):
                doc_id, video_path = futures[future]
                try:
                    if future.result():
                        success += 1
                    else:
                        failed += 1
                        print(f"  Failed: {video_path.name}")
                except Exception as e:
                    failed += 1
                    print(f"  Error: {video_path.name}: {e}")

                # Progress
                if i % 50 == 0:
                    print(f"  Progress: {i}/{len(tasks)}")

        print(f"\nDone! Success: {success}, Failed: {failed}")

    finally:
        session.close()


if __name__ == "__main__":
    main()
