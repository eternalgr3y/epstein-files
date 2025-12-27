#!/usr/bin/env python3
"""
Run the Epstein Files API server.

Usage:
    python run_server.py              # Run API on port 8000
    python run_server.py --port 3000  # Run on different port
"""

import argparse
import sys
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

import uvicorn
from api import app


def main():
    parser = argparse.ArgumentParser(description='Epstein Files API Server')
    parser.add_argument('--port', type=int, default=8000, help='Port to run on')
    parser.add_argument('--host', default='0.0.0.0', help='Host to bind to')
    parser.add_argument('--reload', action='store_true', help='Auto-reload on changes')
    args = parser.parse_args()

    print(f"Epstein Files API: http://{args.host}:{args.port}")

    uvicorn.run(
        "api:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info"
    )


if __name__ == "__main__":
    main()
