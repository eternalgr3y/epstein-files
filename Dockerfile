FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for PyMuPDF
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libmupdf-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY src/ ./src/
COPY frontend/ ./frontend/

# Copy database (213MB)
COPY database/epstein_files.db ./database/epstein_files.db

# Don't copy raw files - they're on R2 CDN now

ENV PYTHONUNBUFFERED=1
ENV EPSTEIN_BASE_DIR=/app

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "src.api:app", "--host", "0.0.0.0", "--port", "8000"]
