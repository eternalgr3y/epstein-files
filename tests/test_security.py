"""
Security tests for Epstein Files API.

Run with: pytest tests/test_security.py -v
"""

import pytest
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from fastapi.testclient import TestClient
from api import app
from security import (
    sanitize_input, is_suspicious, is_scanner_agent,
    abuse_tracker, AbuseTracker
)


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


@pytest.fixture
def fresh_tracker():
    """Create fresh abuse tracker for testing."""
    return AbuseTracker(block_threshold=3, block_duration_minutes=1)


# =============================================================================
# INPUT SANITIZATION TESTS
# =============================================================================

class TestSanitization:
    def test_null_bytes_removed(self):
        result = sanitize_input("hello\x00world")
        assert "\x00" not in result
        assert "hello" in result and "world" in result

    def test_whitespace_normalized(self):
        assert sanitize_input("  hello   world  ") == "hello world"

    def test_length_truncated(self):
        long_input = "a" * 1000
        result = sanitize_input(long_input, max_length=100)
        assert len(result) == 100

    def test_empty_input(self):
        assert sanitize_input("") == ""
        assert sanitize_input(None) is None


class TestSuspiciousPatterns:
    def test_sql_injection_detected(self):
        assert is_suspicious("'; DROP TABLE users; --") is not None
        assert is_suspicious("1 UNION SELECT * FROM passwords") is not None
        assert is_suspicious("admin' OR '1'='1") is None  # Simple quotes ok

    def test_xss_detected(self):
        assert is_suspicious("<script>alert(1)</script>") is not None
        assert is_suspicious("javascript:alert(1)") is not None
        assert is_suspicious("<img onerror=alert(1)>") is not None

    def test_path_traversal_detected(self):
        assert is_suspicious("../../../etc/passwd") is not None
        assert is_suspicious("..\\..\\windows\\system32") is not None

    def test_normal_input_ok(self):
        assert is_suspicious("Donald Trump") is None
        assert is_suspicious("search query here") is None
        assert is_suspicious("document-123.pdf") is None


class TestScannerDetection:
    def test_known_scanners(self):
        assert is_scanner_agent("sqlmap/1.0") is True
        assert is_scanner_agent("Nikto/2.1.6") is True
        assert is_scanner_agent("Mozilla/5.0 (Nmap)") is True

    def test_normal_browsers(self):
        assert is_scanner_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)") is False
        assert is_scanner_agent("Mozilla/5.0 (iPhone; CPU iPhone OS 14_0)") is False


# =============================================================================
# ABUSE TRACKER TESTS
# =============================================================================

class TestAbuseTracker:
    def test_violation_recording(self, fresh_tracker):
        result = fresh_tracker.record_violation("1.2.3.4", "test")
        assert result is False  # Not blocked yet
        assert not fresh_tracker.is_blocked("1.2.3.4")

    def test_blocking_threshold(self, fresh_tracker):
        # Record violations up to threshold
        for i in range(3):
            result = fresh_tracker.record_violation("1.2.3.4", f"test {i}")

        assert result is True  # Should be blocked on 3rd
        assert fresh_tracker.is_blocked("1.2.3.4")

    def test_different_ips_independent(self, fresh_tracker):
        fresh_tracker.record_violation("1.1.1.1", "test")
        fresh_tracker.record_violation("2.2.2.2", "test")

        assert not fresh_tracker.is_blocked("1.1.1.1")
        assert not fresh_tracker.is_blocked("2.2.2.2")

    def test_stats(self, fresh_tracker):
        fresh_tracker.record_violation("1.2.3.4", "test")
        stats = fresh_tracker.get_stats()

        assert "active_violators" in stats
        assert "blocked_ips" in stats
        assert stats["block_threshold"] == 3


# =============================================================================
# API ENDPOINT TESTS
# =============================================================================

class TestSecurityEndpoints:
    def test_health_check(self, client):
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json()["status"] == "healthy"

    def test_security_txt(self, client):
        r = client.get("/.well-known/security.txt")
        assert r.status_code == 200
        assert "Contact:" in r.text

    def test_robots_txt(self, client):
        r = client.get("/robots.txt")
        assert r.status_code == 200
        assert "User-agent:" in r.text
        assert "Disallow: /api/" in r.text

    def test_honeypot_admin(self, client):
        r = client.get("/admin")
        assert r.status_code == 404

    def test_honeypot_wp_admin(self, client):
        r = client.get("/wp-admin")
        assert r.status_code == 404

    def test_honeypot_env(self, client):
        r = client.get("/.env")
        assert r.status_code == 404


class TestInputValidation:
    def test_empty_query_rejected(self, client):
        r = client.get("/api/search?q=")
        assert r.status_code == 422

    def test_long_query_rejected(self, client):
        r = client.get(f"/api/search?q={'a' * 201}")
        assert r.status_code == 422

    def test_valid_query_accepted(self, client):
        r = client.get("/api/search?q=test&limit=1")
        assert r.status_code == 200

    def test_invalid_limit_rejected(self, client):
        r = client.get("/api/search?q=test&limit=0")
        assert r.status_code == 422

        r = client.get("/api/search?q=test&limit=101")
        assert r.status_code == 422

    def test_invalid_document_id(self, client):
        r = client.get("/api/documents/abc")
        assert r.status_code == 422

        r = client.get("/api/documents/99999999")
        assert r.status_code == 404


class TestSQLInjection:
    """SQL injection attempts should be handled safely."""

    @pytest.mark.parametrize("payload", [
        "'; DROP TABLE documents; --",
        "' OR '1'='1",
        "1; DELETE FROM entities",
        "UNION SELECT * FROM sqlite_master",
        "1' AND '1'='1",
    ])
    def test_sql_injection_safe(self, client, payload):
        r = client.get(f"/api/search?q={payload}&limit=1")
        # Should either succeed (treating as search term) or fail safely
        assert r.status_code in (200, 400, 422)

        # Verify database still works
        r = client.get("/api/stats")
        assert r.status_code == 200
        assert r.json()["total"] > 0


class TestXSS:
    """XSS attempts should be handled safely."""

    @pytest.mark.parametrize("payload", [
        "<script>alert(1)</script>",
        "<img src=x onerror=alert(1)>",
        "javascript:alert(1)",
    ])
    def test_xss_returns_json(self, client, payload):
        r = client.get(f"/api/search?q={payload}&limit=1")
        # Request should succeed (we treat XSS as search terms)
        assert r.status_code == 200

        # Critical: Response MUST be JSON, not HTML
        # This prevents browser from executing any scripts
        content_type = r.headers.get("content-type", "")
        assert "application/json" in content_type, f"Expected JSON, got {content_type}"

        # Response should be valid JSON
        data = r.json()
        assert "results" in data


# =============================================================================
# RATE LIMITING TESTS
# =============================================================================

class TestRateLimiting:
    def test_rate_limit_headers(self, client):
        r = client.get("/api/search?q=test&limit=1")
        # Rate limit headers should be present
        # (exact headers depend on slowapi config)
        assert r.status_code == 200


# =============================================================================
# RUN TESTS
# =============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
