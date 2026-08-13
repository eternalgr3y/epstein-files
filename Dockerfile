# Immutable multi-platform manifest for the Docker Official Image
# python:3.11.15-slim-trixie (refreshed 2026-08-05).
FROM python:3.11.15-slim-trixie@sha256:90744cff8f32887f075c47d747a173ff333e9e98801667af93c357fa9f5e28ff

WORKDIR /app

# Install the Python 3.11 dependency set from hash-verified wheels only. The
# locked PyMuPDF wheel bundles MuPDF, so this image needs no compiler or apt
# packages. This is also verified for the supported Linux target in
# docker-reproducibility.test.js / the documented refresh workflow.
#
# Security refresh workflow: update the Python patch tag + OCI digest, refresh
# requirements.lock.txt, verify a wheel-only Linux resolution, then rebuild with
# --no-cache and scan/test the resulting image. Update both pins together.
COPY requirements.lock.txt .
RUN pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.lock.txt

# Copy application code
COPY src/ ./src/
COPY frontend/ ./frontend/

# Copy database (213MB)
COPY database/epstein_files.db ./database/epstein_files.db

# Don't copy raw files - they're on R2 CDN now

ENV PYTHONUNBUFFERED=1
ENV EPSTEIN_BASE_DIR=/app

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "api:app", "--app-dir", "/app/src", "--host", "0.0.0.0", "--port", "8000"]
