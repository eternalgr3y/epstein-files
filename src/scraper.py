"""
DOJ Epstein Files Scraper

Scrapes documents from justice.gov/epstein with full provenance tracking.
Uses Playwright to bypass Akamai bot protection and handle downloads.
"""

import asyncio
import aiofiles
import json
import hashlib
import logging
import os
import re
from pathlib import Path
from datetime import datetime
from urllib.parse import urljoin, urlparse
from dataclasses import dataclass, asdict
from typing import Optional
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

# Configuration - use environment variables or relative paths
BASE_DIR = Path(os.getenv("EPSTEIN_BASE_DIR", Path(__file__).parent.parent))
BASE_URL = "https://www.justice.gov/epstein"
DOWNLOAD_DIR = BASE_DIR / "raw"
METADATA_DIR = BASE_DIR / "processed" / "metadata"
STATE_FILE = BASE_DIR / "scraper_state.json"
LOG_FILE = BASE_DIR / "scraper.log"

# Rate limiting
DELAY_BETWEEN_REQUESTS = 1.0  # seconds
REQUEST_TIMEOUT = 120000  # milliseconds

# Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(str(LOG_FILE)),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


@dataclass
class DocumentMetadata:
    """Provenance and metadata for a downloaded document."""
    url: str
    filename: str
    local_path: str
    file_hash: str
    file_size: int
    content_type: str
    source_page: str
    data_set: Optional[str]
    category: Optional[str]
    download_timestamp: str
    last_modified: Optional[str]
    title: Optional[str]

    def to_dict(self):
        return asdict(self)


class ScraperState:
    """Tracks scraper progress for resumability."""

    def __init__(self, state_file: Path):
        self.state_file = state_file
        self.downloaded_urls: set = set()
        self.failed_urls: dict = {}
        self.discovered_urls: set = set()
        self.load()

    def load(self):
        if self.state_file.exists():
            with open(self.state_file, 'r') as f:
                data = json.load(f)
                self.downloaded_urls = set(data.get('downloaded_urls', []))
                self.failed_urls = data.get('failed_urls', {})
                self.discovered_urls = set(data.get('discovered_urls', []))
            logger.info(f"Loaded state: {len(self.downloaded_urls)} downloaded, {len(self.failed_urls)} failed")

    def save(self):
        with open(self.state_file, 'w') as f:
            json.dump({
                'downloaded_urls': list(self.downloaded_urls),
                'failed_urls': self.failed_urls,
                'discovered_urls': list(self.discovered_urls),
                'last_updated': datetime.now().isoformat()
            }, f, indent=2)

    def mark_downloaded(self, url: str):
        self.downloaded_urls.add(url)
        self.failed_urls.pop(url, None)

    def mark_failed(self, url: str, error: str):
        self.failed_urls[url] = error

    def is_downloaded(self, url: str) -> bool:
        return url in self.downloaded_urls


class DOJScraper:
    """Scrapes DOJ Epstein files with provenance tracking."""

    def __init__(self):
        self.state = ScraperState(STATE_FILE)
        self.browser = None
        self.context = None
        self.playwright = None

        # Ensure directories exist
        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        METADATA_DIR.mkdir(parents=True, exist_ok=True)

    async def __aenter__(self):
        # Start Playwright browser with download handling
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(headless=True)

        # Context with download path set
        self.context = await self.browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            accept_downloads=True
        )

        return self

    async def __aexit__(self, *args):
        if self.context:
            await self.context.close()
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()
        self.state.save()

    async def fetch_page(self, url: str) -> str:
        """Fetch a page using Playwright to bypass bot protection."""
        page = await self.context.new_page()
        try:
            logger.info(f"Fetching: {url}")
            await page.goto(url, wait_until='networkidle', timeout=60000)
            await page.wait_for_selector('body', timeout=30000)
            await asyncio.sleep(2)
            content = await page.content()
            return content
        finally:
            await page.close()

    async def discover_document_links(self) -> list[dict]:
        """Crawl the DOJ site to find all document links."""
        documents = []
        pages_to_crawl = [
            (BASE_URL, "main"),
            (f"{BASE_URL}/doj-disclosures", "doj-disclosures"),
            (f"{BASE_URL}/court-records", "court-records"),
        ]

        crawled = set()
        logger.info("Discovering document pages...")

        i = 0
        while i < len(pages_to_crawl):
            page_url, category = pages_to_crawl[i]
            i += 1

            if page_url in crawled:
                continue
            crawled.add(page_url)

            try:
                await asyncio.sleep(DELAY_BETWEEN_REQUESTS)
                html = await self.fetch_page(page_url)
                soup = BeautifulSoup(html, 'lxml')

                for link in soup.find_all('a', href=True):
                    href = link['href']
                    full_url = urljoin(page_url, href)

                    if 'justice.gov' not in full_url:
                        continue
                    if any(x in full_url.lower() for x in ['facebook.', 'twitter.', 'linkedin.', 'mailto:', 'javascript:']):
                        continue

                    if 'data-set' in href.lower() and 'justice.gov' in full_url and full_url not in crawled:
                        data_set_name = href.split('/')[-1] if '/' in href else href
                        pages_to_crawl.append((full_url, f"data-set-{data_set_name}"))
                        logger.info(f"Found data set page: {full_url}")

                    if self._is_document_url(full_url):
                        title = link.get_text(strip=True) or None
                        data_set = self._extract_data_set(page_url)

                        documents.append({
                            'url': full_url,
                            'title': title,
                            'source_page': page_url,
                            'category': category,
                            'data_set': data_set
                        })
                        self.state.discovered_urls.add(full_url)

            except Exception as e:
                logger.error(f"Error crawling {page_url}: {e}")

        seen = set()
        unique_docs = []
        for doc in documents:
            if doc['url'] not in seen:
                seen.add(doc['url'])
                unique_docs.append(doc)

        logger.info(f"Discovered {len(unique_docs)} unique documents across {len(crawled)} pages")
        self.state.save()
        return unique_docs

    def _is_document_url(self, url: str) -> bool:
        parsed = urlparse(url)
        path_lower = parsed.path.lower()
        doc_extensions = ('.pdf', '.jpg', '.jpeg', '.png', '.gif', '.tiff', '.doc', '.docx', '.txt', '.zip')

        if any(path_lower.endswith(ext) for ext in doc_extensions):
            return True
        if 'justice.gov' in parsed.netloc and '/files/' in path_lower:
            return True
        return False

    def _extract_data_set(self, url: str) -> Optional[str]:
        match = re.search(r'data-set-(\d+)', url.lower())
        if match:
            return f"data-set-{match.group(1)}"
        match = re.search(r'data-set-([^/]+)', url.lower())
        if match:
            return f"data-set-{match.group(1)}"
        return None

    def _generate_filename(self, url: str, suggested_name: Optional[str] = None) -> str:
        if suggested_name:
            safe_name = re.sub(r'[^\w\-_.]', '_', suggested_name)
            return safe_name

        parsed = urlparse(url)
        original_name = Path(parsed.path).name

        if not original_name or original_name == '/':
            url_hash = hashlib.md5(url.encode()).hexdigest()[:12]
            return f"doc_{url_hash}.bin"

        safe_name = re.sub(r'[^\w\-_.]', '_', original_name)
        return safe_name

    async def download_document(self, doc_info: dict) -> Optional[DocumentMetadata]:
        """Download a document using Playwright's download handling."""
        url = doc_info['url']

        if self.state.is_downloaded(url):
            return None

        page = await self.context.new_page()
        try:
            await asyncio.sleep(DELAY_BETWEEN_REQUESTS)

            # Determine subdirectory
            if doc_info.get('data_set'):
                subdir = DOWNLOAD_DIR / doc_info['data_set']
            else:
                subdir = DOWNLOAD_DIR / doc_info.get('category', 'other')
            subdir.mkdir(parents=True, exist_ok=True)

            # Set up download handler - capture downloads that happen on navigation
            download = None

            def handle_download(d):
                nonlocal download
                download = d

            page.on("download", handle_download)

            # Try to navigate - this may trigger a download or display content
            response = None
            nav_error = None
            try:
                response = await page.goto(url, timeout=REQUEST_TIMEOUT, wait_until='commit')
            except Exception as e:
                nav_error = e
                # Wait a moment for download to be captured
                await asyncio.sleep(0.5)

            # If we got a download, process it
            if download:
                # Wait for download to complete
                suggested = download.suggested_filename
                filename = self._generate_filename(url, suggested)

                # Handle duplicates
                local_path = subdir / filename
                counter = 1
                original_stem = Path(filename).stem
                suffix = Path(filename).suffix
                while local_path.exists():
                    local_path = subdir / f"{original_stem}_{counter}{suffix}"
                    counter += 1

                # Save file
                await download.save_as(str(local_path))

                # Read for hash
                async with aiofiles.open(local_path, 'rb') as f:
                    content = await f.read()

                file_hash = hashlib.sha256(content).hexdigest()

                # Determine content type from extension
                ext = suffix.lower()
                content_type_map = {
                    '.pdf': 'application/pdf',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.png': 'image/png',
                    '.gif': 'image/gif',
                    '.zip': 'application/zip',
                    '.txt': 'text/plain',
                }
                content_type = content_type_map.get(ext, 'application/octet-stream')

                metadata = DocumentMetadata(
                    url=url,
                    filename=local_path.name,
                    local_path=str(local_path),
                    file_hash=file_hash,
                    file_size=len(content),
                    content_type=content_type,
                    source_page=doc_info['source_page'],
                    data_set=doc_info.get('data_set'),
                    category=doc_info.get('category'),
                    download_timestamp=datetime.now().isoformat(),
                    last_modified=None,
                    title=doc_info.get('title')
                )

                # Save metadata
                meta_path = METADATA_DIR / f"{local_path.stem}.json"
                async with aiofiles.open(meta_path, 'w') as f:
                    await f.write(json.dumps(metadata.to_dict(), indent=2))

                self.state.mark_downloaded(url)
                logger.info(f"Downloaded: {filename} ({len(content)} bytes)")
                return metadata

            # No download triggered - check if we got a response with content
            elif response:
                content = await response.body()
                content_type = response.headers.get('content-type', 'application/octet-stream')

                filename = self._generate_filename(url)
                local_path = subdir / filename
                counter = 1
                original_stem = Path(filename).stem
                suffix = Path(filename).suffix
                while local_path.exists():
                    local_path = subdir / f"{original_stem}_{counter}{suffix}"
                    counter += 1

                async with aiofiles.open(local_path, 'wb') as f:
                    await f.write(content)

                file_hash = hashlib.sha256(content).hexdigest()

                metadata = DocumentMetadata(
                    url=url,
                    filename=local_path.name,
                    local_path=str(local_path),
                    file_hash=file_hash,
                    file_size=len(content),
                    content_type=content_type,
                    source_page=doc_info['source_page'],
                    data_set=doc_info.get('data_set'),
                    category=doc_info.get('category'),
                    download_timestamp=datetime.now().isoformat(),
                    last_modified=None,
                    title=doc_info.get('title')
                )

                meta_path = METADATA_DIR / f"{local_path.stem}.json"
                async with aiofiles.open(meta_path, 'w') as f:
                    await f.write(json.dumps(metadata.to_dict(), indent=2))

                self.state.mark_downloaded(url)
                logger.info(f"Downloaded (direct): {filename} ({len(content)} bytes)")
                return metadata

            else:
                # Navigation failed and no download was captured
                error_msg = str(nav_error) if nav_error else "No response or download"
                logger.error(f"Failed to download {url}: {error_msg}")
                self.state.mark_failed(url, error_msg)
                return None

        except Exception as e:
            error_msg = str(e)
            logger.error(f"Failed to download {url}: {error_msg}")
            self.state.mark_failed(url, error_msg)
            return None

        finally:
            await page.close()

    async def run(self, retry_failed: bool = False):
        """Run the full scraping process."""
        logger.info("Starting DOJ Epstein Files scraper...")

        documents = await self.discover_document_links()

        to_download = [d for d in documents if not self.state.is_downloaded(d['url'])]

        if retry_failed:
            failed_docs = [{'url': url, 'source_page': 'retry', 'category': 'retry'}
                          for url in self.state.failed_urls.keys()]
            to_download.extend(failed_docs)

        logger.info(f"Documents to download: {len(to_download)}")

        if not to_download:
            logger.info("Nothing to download!")
            return

        successful = 0
        failed = 0

        for i, doc_info in enumerate(to_download):
            result = await self.download_document(doc_info)
            if result:
                successful += 1
            else:
                if not self.state.is_downloaded(doc_info['url']):
                    failed += 1

            if (successful + failed) % 10 == 0:
                self.state.save()
                logger.info(f"Progress: {i+1}/{len(to_download)} ({successful} ok, {failed} failed)")

        self.state.save()
        logger.info(f"Complete! Downloaded: {successful}, Failed: {failed}")
        logger.info(f"Total in collection: {len(self.state.downloaded_urls)}")


async def main():
    """Main entry point."""
    async with DOJScraper() as scraper:
        await scraper.run(retry_failed=True)


if __name__ == "__main__":
    asyncio.run(main())
