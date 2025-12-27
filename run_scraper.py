#!/usr/bin/env python3
"""
Run the DOJ Epstein Files scraper.

Usage:
    python run_scraper.py              # Normal run
    python run_scraper.py --retry      # Retry failed downloads
    python run_scraper.py --discover   # Only discover links, don't download
"""

import asyncio
import argparse
import sys
sys.path.insert(0, '/mnt/e/epstein-files/src')

from scraper import DOJScraper


async def main():
    parser = argparse.ArgumentParser(description='DOJ Epstein Files Scraper')
    parser.add_argument('--retry', action='store_true', help='Retry failed downloads')
    parser.add_argument('--discover', action='store_true', help='Only discover links')
    args = parser.parse_args()

    async with DOJScraper() as scraper:
        if args.discover:
            docs = await scraper.discover_document_links()
            print(f"\nDiscovered {len(docs)} documents:")
            for doc in docs[:20]:
                print(f"  - {doc['url']}")
            if len(docs) > 20:
                print(f"  ... and {len(docs) - 20} more")
        else:
            await scraper.run(retry_failed=args.retry)


if __name__ == "__main__":
    asyncio.run(main())
