"""
Import the House Oversight DOJ Records batch (second House Oversight release)
into the database.

Unlike the Estate batch, this production has no pre-extracted text and no
per-document native-format grouping in the load file structure — instead:
  - `.dat` lists Bates ranges + original filenames, with FILE_PATH populated
    only for the 83 native audio/video documents.
  - `.opt` lists one row per page image, with a doc-break marker (`Y`) and a
    page count on the first page of each document.

The 1,575 page-scanned documents get their page images combined into a single
PDF each (so the existing single-file-per-Document OCR pipeline works
unmodified); the 83 native audio/video files are imported as direct
video/audio Document rows.
"""

import logging
from pathlib import Path
from typing import Optional, Dict, List

import fitz  # PyMuPDF

from models import (
    get_engine, get_session, init_database, Document, DocumentType,
    ProcessingStatus, utc_now,
)
from config import BASE_DIR

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# The batch was downloaded straight to the home directory (too large for the
# project's own raw/ tree) — see scrape_dropbox.py's BASE_DIR.
SOURCE_DIR = Path.home() / "epstein-raw" / "house-oversight-doj" / "Prod 01_ 20250822"
DAT_FILE = SOURCE_DIR / "20250822.dat"
OPT_FILE = SOURCE_DIR / "20250822.opt"

# Combined PDFs live under the project's own raw/ tree (not the download
# location) because (a) the OCR pipeline reads Document.local_path directly
# off disk, and (b) worker.js derives each doc's R2 key from whatever follows
# "epstein-files/" in local_path — so this path doubles as the eventual R2
# key prefix (raw/house-oversight-doj/...), matching every other data_set's
# convention.
OUTPUT_DIR = BASE_DIR / "raw" / "house-oversight-doj"

DATA_SET = 'house-oversight-doj'
DAT_DELIM = 'þ\x14þ'

NATIVE_CONTENT_TYPES = {
    '.mp4': ('video/mp4', 'video'),
    '.wav': ('audio/wav', 'audio'),
}


def parse_dat_file(dat_path: Path) -> List[Dict]:
    """Parse the þ\\x14þ-delimited DAT file. Same format as the Estate batch's,
    but a simpler schema: Prod Beg, Prod End, Filename, FILE_PATH."""
    # This production's DAT file is single-byte encoded (þ = raw byte 0xFE),
    # unlike the Estate batch's UTF-8 one — latin-1 round-trips every byte
    # 1:1 so the þ/0x14 delimiter bytes match exactly regardless of encoding.
    with open(dat_path, 'r', encoding='latin-1') as f:
        content = f.read()

    lines = content.strip().split('\n')
    header_line = lines[0].strip('þ\x14\r')
    headers = [h.strip() for h in header_line.split(DAT_DELIM)]
    logger.info(f"DAT headers: {headers}")

    documents = []
    for line in lines[1:]:
        if not line.strip():
            continue
        line_clean = line.strip('þ\x14\r')
        fields = [f.strip() for f in line_clean.split(DAT_DELIM)]
        doc = {headers[i]: (fields[i] if i < len(fields) and fields[i] else None)
               for i in range(len(headers))}
        documents.append({
            'bates_begin': doc.get('Prod Beg'),
            'bates_end': doc.get('Prod End'),
            'filename': doc.get('Filename'),
            'file_path': doc.get('FILE_PATH'),
        })

    logger.info(f"Parsed {len(documents)} documents from DAT file")
    return documents


def parse_opt_file(opt_path: Path) -> Dict[str, Dict]:
    """Parse the OPT file into per-document page lists.

    Returns bates_begin -> {"image_paths": [...], "page_count": N}.
    """
    doc_pages: Dict[str, Dict] = {}
    current_bates = None
    current_images: List[str] = []
    current_page_count = None

    def flush():
        if current_bates and current_images:
            doc_pages[current_bates] = {
                'image_paths': current_images,
                'page_count': current_page_count or len(current_images),
            }

    with open(opt_path, 'r') as f:
        for line in f:
            parts = line.strip().split(',')
            if len(parts) < 7:
                continue
            bates, _volume, image_path, doc_break = parts[0], parts[1], parts[2], parts[3]
            page_count = parts[6]

            if doc_break == 'Y':
                flush()
                current_bates = bates
                current_images = [image_path]
                current_page_count = int(page_count) if page_count.isdigit() else None
            else:
                current_images.append(image_path)

        flush()

    logger.info(f"Parsed {len(doc_pages)} document page groupings from OPT file")
    return doc_pages


def resolve_local_image_path(opt_image_path: str) -> Path:
    """OPT paths are Windows-style relative paths like
    '.\\VOL00001\\IMAGES\\IMAGES001\\DOJ-OGR-00000001.tif'."""
    rel = opt_image_path.replace('\\', '/').lstrip('./')
    return SOURCE_DIR / rel


def resolve_native_path(dat_file_path: str) -> Path:
    """DAT FILE_PATH values look like '.\\VOL00001\\NATIVES\\NATIVE006\\DOJ-OGR-00015624.MP4'."""
    rel = dat_file_path.replace('\\', '/').lstrip('./')
    return SOURCE_DIR / rel


def build_combined_pdf(image_paths: List[Path], output_path: Path) -> Optional[int]:
    """Combine ordered page images into a single PDF, one image at a time to
    keep memory bounded (some documents run 1000+ pages). Returns page count
    written, or None on failure."""
    if output_path.exists():
        try:
            existing = fitz.open(str(output_path))
            n = existing.page_count
            existing.close()
            return n
        except Exception:
            pass  # corrupt partial file from an interrupted prior run — rebuild

    out_doc = fitz.open()
    written = 0
    try:
        for img_path in image_paths:
            if not img_path.exists():
                logger.warning(f"  missing page image: {img_path}")
                continue
            try:
                img_doc = fitz.open(str(img_path))
                pdf_bytes = img_doc.convert_to_pdf()
                img_doc.close()
                page_pdf = fitz.open("pdf", pdf_bytes)
                out_doc.insert_pdf(page_pdf)
                page_pdf.close()
                written += 1
            except Exception as e:
                logger.warning(f"  failed to add page {img_path}: {e}")

        if written == 0:
            return None

        output_path.parent.mkdir(parents=True, exist_ok=True)
        out_doc.save(str(output_path))
        return written
    finally:
        out_doc.close()


def import_documents(session, dat_rows: List[Dict], doc_pages: Dict[str, Dict]):
    imported = 0
    skipped = 0
    pdf_built = 0
    native_count = 0
    errors = []

    for i, row in enumerate(dat_rows, 1):
        bates_begin = row['bates_begin']
        if not bates_begin:
            continue

        existing = session.query(Document).filter_by(
            filename=bates_begin, data_set=DATA_SET
        ).first()
        if existing:
            skipped += 1
            continue

        is_native = bool(row['file_path'])

        if is_native:
            native_src = resolve_native_path(row['file_path'])
            ext = native_src.suffix.lower()
            content_type, doc_type = NATIVE_CONTENT_TYPES.get(ext, ('application/octet-stream', 'other'))
            if not native_src.exists():
                errors.append(f"{bates_begin}: native file missing: {native_src}")
                continue

            local_path = str(OUTPUT_DIR / f"{bates_begin}{ext}")
            db_doc = Document(
                source_url=f"https://oversight.house.gov/doj-epstein-records/{bates_begin}",
                source_page="https://oversight.house.gov",
                data_set=DATA_SET,
                category='house-oversight',
                filename=bates_begin,
                local_path=local_path,
                file_size=native_src.stat().st_size,
                content_type=content_type,
                document_type=doc_type,
                title=row['filename'] or bates_begin,
                download_timestamp=utc_now(),
                processing_status=ProcessingStatus.COMPLETED.value,
                page_count=1,
                has_text=False,
                needs_ocr=False,
            )
            session.add(db_doc)
            native_count += 1
        else:
            pages = doc_pages.get(bates_begin)
            if not pages:
                errors.append(f"{bates_begin}: no page images found in OPT file")
                continue

            image_paths = [resolve_local_image_path(p) for p in pages['image_paths']]
            output_path = OUTPUT_DIR / f"{bates_begin}.pdf"
            page_count = build_combined_pdf(image_paths, output_path)
            if not page_count:
                errors.append(f"{bates_begin}: PDF build failed (0 pages written)")
                continue
            pdf_built += 1

            db_doc = Document(
                source_url=f"https://oversight.house.gov/doj-epstein-records/{bates_begin}",
                source_page="https://oversight.house.gov",
                data_set=DATA_SET,
                category='house-oversight',
                filename=bates_begin,
                local_path=str(output_path),
                file_size=output_path.stat().st_size,
                content_type='application/pdf',
                document_type=DocumentType.PDF.value,
                title=row['filename'] or bates_begin,
                download_timestamp=utc_now(),
                processing_status=ProcessingStatus.PENDING.value,
                page_count=page_count,
                has_text=False,
                needs_ocr=True,
            )
            session.add(db_doc)

        imported += 1
        if imported % 50 == 0:
            session.commit()
            logger.info(f"[{i}/{len(dat_rows)}] imported={imported} (pdf={pdf_built}, native={native_count}) skipped={skipped} errors={len(errors)}")

    session.commit()
    logger.info("=" * 60)
    logger.info(f"Import complete: {imported} imported ({pdf_built} PDFs, {native_count} native), {skipped} skipped, {len(errors)} errors")
    if errors:
        logger.info("Errors:")
        for e in errors[:30]:
            logger.info(f"  {e}")
    return imported, skipped, errors


def main():
    logger.info("=" * 60)
    logger.info("House Oversight DOJ Records Import")
    logger.info("=" * 60)

    if not DAT_FILE.exists() or not OPT_FILE.exists():
        logger.error(f"Load files not found under {SOURCE_DIR}")
        return

    engine = init_database()
    session = get_session(engine)

    try:
        dat_rows = parse_dat_file(DAT_FILE)
        doc_pages = parse_opt_file(OPT_FILE)
        import_documents(session, dat_rows, doc_pages)

        total = session.query(Document).filter_by(data_set=DATA_SET).count()
        logger.info(f"Total {DATA_SET} docs in database: {total}")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
