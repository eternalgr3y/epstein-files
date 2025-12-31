"""
Extract images from PDF files - PARALLEL VERSION
"""

import sys
import fitz  # PyMuPDF
from pathlib import Path
from multiprocessing import Pool, cpu_count
import hashlib
import json
import os

sys.path.insert(0, str(Path(__file__).parent))
from config import BASE_DIR

# Output directory
IMAGES_DIR = BASE_DIR / "images"
IMAGES_DIR.mkdir(exist_ok=True)

# Minimum image size
MIN_WIDTH = 100
MIN_HEIGHT = 100


def process_single_pdf(args):
    """Process a single PDF - worker function."""
    doc_id, pdf_path = args
    extracted = []
    seen_hashes = set()

    try:
        pdf = fitz.open(pdf_path)

        for page_num in range(len(pdf)):
            page = pdf[page_num]
            images = page.get_images()

            for img_idx, img in enumerate(images):
                xref = img[0]

                try:
                    base_image = pdf.extract_image(xref)
                    if not base_image:
                        continue

                    image_bytes = base_image["image"]
                    ext = base_image["ext"]
                    width = base_image.get("width", 0)
                    height = base_image.get("height", 0)

                    # Skip small images
                    if width < MIN_WIDTH or height < MIN_HEIGHT:
                        continue

                    # Skip duplicates
                    img_hash = hashlib.md5(image_bytes).hexdigest()[:12]
                    if img_hash in seen_hashes:
                        continue
                    seen_hashes.add(img_hash)

                    # Save image
                    filename = f"{doc_id}_p{page_num}_{img_idx}.{ext}"
                    filepath = IMAGES_DIR / filename
                    filepath.write_bytes(image_bytes)

                    extracted.append({
                        "filename": filename,
                        "doc_id": doc_id,
                        "page": page_num,
                        "width": width,
                        "height": height,
                        "size": len(image_bytes)
                    })

                except:
                    continue

        pdf.close()

    except Exception as e:
        pass

    return extracted


def main():
    from models import get_engine, get_session, Document

    engine = get_engine()
    session = get_session(engine)

    # Get all PDFs
    pdfs = session.query(Document).filter(Document.document_type == "pdf").all()
    print(f"Found {len(pdfs)} PDFs to process")

    # Build work list
    work = []
    for doc in pdfs:
        pdf_path = Path(doc.local_path)
        if pdf_path.exists():
            work.append((doc.id, str(pdf_path)))

    print(f"Processing {len(work)} PDFs with {cpu_count()} workers...")

    # Parallel processing
    all_images = []
    with Pool(processes=cpu_count()) as pool:
        for i, result in enumerate(pool.imap_unordered(process_single_pdf, work, chunksize=50)):
            all_images.extend(result)
            if (i + 1) % 500 == 0:
                print(f"  {i + 1}/{len(work)} PDFs, {len(all_images)} images extracted")

    # Save manifest
    manifest_path = IMAGES_DIR / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump({
            "total_images": len(all_images),
            "images": all_images
        }, f)

    print(f"\nDone! Extracted {len(all_images)} images")

    session.close()


if __name__ == "__main__":
    main()
