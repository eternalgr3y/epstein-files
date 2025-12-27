#!/usr/bin/env python3
"""Run the API server with correct paths."""

import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / 'src'))

import uvicorn
from api import app

if __name__ == "__main__":
    print("Starting Epstein Files API on http://localhost:8000")
    print("Docs at http://localhost:8000/docs")
    uvicorn.run(app, host="0.0.0.0", port=8000)
