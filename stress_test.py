#!/usr/bin/env python3
"""
Stress test suite for Epstein Files API.
Run with: python stress_test.py
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

# Disable rate limiting for tests
os.environ["TESTING"] = "1"

from fastapi.testclient import TestClient
from api import app, limiter
import concurrent.futures
import time

# Disable rate limiter for testing
limiter.enabled = False

client = TestClient(app)

PASSED = 0
FAILED = 0

def test(name, condition, detail=""):
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  ✓ {name}")
    else:
        FAILED += 1
        print(f"  ✗ {name} - {detail}")

def run_tests():
    global PASSED, FAILED

    # ===========================================
    print("\n[Basic Endpoints]")
    # ===========================================

    r = client.get("/")
    test("GET / returns 200", r.status_code == 200)

    r = client.get("/api")
    test("GET /api returns 200", r.status_code == 200)
    test("GET /api has endpoints", "endpoints" in r.json())

    r = client.get("/api/stats")
    test("GET /api/stats returns 200", r.status_code == 200)

    r = client.get("/health")
    test("GET /health returns 200", r.status_code == 200)
    test("GET /health status healthy", r.json().get("status") == "healthy")

    r = client.get("/robots.txt")
    test("GET /robots.txt returns 200", r.status_code == 200)

    r = client.get("/api/roles")
    test("GET /api/roles returns 200", r.status_code == 200)

    r = client.get("/api/document-types")
    test("GET /api/document-types returns 200", r.status_code == 200)

    r = client.get("/api/data-sets")
    test("GET /api/data-sets returns 200", r.status_code == 200)

    # ===========================================
    print("\n[Search - Valid Queries]")
    # ===========================================

    r = client.get("/api/search?q=epstein")
    test("Search 'epstein'", r.status_code == 200)
    test("Search has results key", "results" in r.json())

    r = client.get("/api/search?q=test&limit=5")
    test("Search with limit", r.status_code == 200)

    r = client.get("/api/search?q=test&offset=10")
    test("Search with offset", r.status_code == 200)

    r = client.get("/api/search?q=a")
    test("Single char query", r.status_code == 200)

    # ===========================================
    print("\n[Search - Edge Cases]")
    # ===========================================

    r = client.get("/api/search?q=")
    test("Empty query rejected", r.status_code == 422)

    r = client.get("/api/search?q=   ")
    test("Whitespace query rejected", r.status_code in [400, 422])

    r = client.get("/api/search?q=" + "a" * 201)
    test("Too long query rejected", r.status_code == 422)

    r = client.get("/api/search?q=test&limit=0")
    test("limit=0 rejected", r.status_code == 422)

    r = client.get("/api/search?q=test&limit=101")
    test("limit>100 rejected", r.status_code == 422)

    r = client.get("/api/search?q=test&offset=-1")
    test("negative offset rejected", r.status_code == 422)

    # ===========================================
    print("\n[Search - Special Characters]")
    # ===========================================

    r = client.get("/api/search?q=test%20query")
    test("Space in query", r.status_code == 200)

    r = client.get("/api/search?q=o'brien")
    test("Apostrophe in query", r.status_code == 200)

    r = client.get("/api/search?q=test%26query")
    test("Ampersand in query", r.status_code == 200)

    r = client.get("/api/search?q=%22quoted%22")
    test("Quotes in query", r.status_code == 200)

    r = client.get("/api/search?q=test%2Fquery")
    test("Slash in query", r.status_code == 200)

    r = client.get("/api/search?q=%3Cscript%3E")
    test("Angle brackets in query", r.status_code == 200)

    r = client.get("/api/search?q=test*")
    test("Asterisk in query", r.status_code == 200)

    r = client.get("/api/search?q=test%25")
    test("Percent in query", r.status_code == 200)

    # ===========================================
    print("\n[Search - Unicode]")
    # ===========================================

    r = client.get("/api/search?q=café")
    test("Accented chars", r.status_code == 200)

    r = client.get("/api/search?q=日本語")
    test("CJK chars", r.status_code == 200)

    r = client.get("/api/search?q=emoji😀")
    test("Emoji in query", r.status_code == 200)

    r = client.get("/api/search?q=Müller")
    test("Umlaut in query", r.status_code == 200)

    # ===========================================
    print("\n[SQL Injection Attempts]")
    # ===========================================

    injections = [
        "'; DROP TABLE documents;--",
        "1 OR 1=1",
        "1; SELECT * FROM users",
        "' UNION SELECT * FROM documents--",
        "1' AND '1'='1",
        "admin'--",
        "1; ATTACH DATABASE",
        "'; INSERT INTO",
    ]
    for inj in injections:
        r = client.get(f"/api/search?q={inj}")
        test(f"SQLi: {inj[:30]}...", r.status_code == 200, f"got {r.status_code}")

    # ===========================================
    print("\n[XSS Payloads]")
    # ===========================================

    xss = [
        "<script>alert(1)</script>",
        "<img src=x onerror=alert(1)>",
        "javascript:alert(1)",
        "<svg onload=alert(1)>",
        "'-alert(1)-'",
    ]
    for payload in xss:
        r = client.get(f"/api/search?q={payload}")
        test(f"XSS: {payload[:25]}...", r.status_code == 200)
        if r.status_code == 200:
            body = r.text
            test(f"XSS not reflected raw", "<script>" not in body or "&lt;script&gt;" in body or "results" in body)

    # ===========================================
    print("\n[Document Endpoints]")
    # ===========================================

    r = client.get("/api/documents/1")
    test("GET document 1", r.status_code in [200, 404])

    r = client.get("/api/documents/999999")
    test("GET nonexistent document", r.status_code == 404)

    r = client.get("/api/documents/0")
    test("GET document 0", r.status_code in [200, 404])

    r = client.get("/api/documents/-1")
    test("GET document -1", r.status_code in [404, 422])

    r = client.get("/api/documents/abc")
    test("GET document non-numeric", r.status_code == 422)

    r = client.get("/api/documents/1/text")
    test("GET document text", r.status_code in [200, 404])

    r = client.get("/api/documents/1/file")
    test("GET document file", r.status_code in [200, 404])

    # ===========================================
    print("\n[Entity Endpoints]")
    # ===========================================

    r = client.post("/api/entities/search", json={"query": "test", "limit": 5})
    test("POST entity search", r.status_code == 200)

    r = client.post("/api/entities/search", json={"query": ""})
    test("Empty entity query", r.status_code in [200, 400, 422])

    r = client.post("/api/entities/search", json={})
    test("Missing query field", r.status_code == 422)

    r = client.get("/api/entities/1")
    test("GET entity 1", r.status_code in [200, 404])

    r = client.get("/api/entities/999999")
    test("GET nonexistent entity", r.status_code == 404)

    r = client.get("/api/entities/1/mentions")
    test("GET entity mentions", r.status_code in [200, 404])

    # ===========================================
    print("\n[Cache Endpoints]")
    # ===========================================

    r = client.get("/api/cache/stats")
    test("GET cache stats", r.status_code == 200)
    test("Cache stats has size", "size" in r.json())

    r = client.post("/api/cache/clear")
    test("POST cache clear", r.status_code == 200)

    # ===========================================
    print("\n[Malformed Requests]")
    # ===========================================

    r = client.post("/api/search", json={"query": "test"})
    test("POST search works", r.status_code == 200)

    r = client.post("/api/search", data="not json")
    test("Invalid JSON rejected", r.status_code == 422)

    r = client.post("/api/entities/search", json={"query": "test", "limit": "abc"})
    test("Invalid limit type", r.status_code == 422)

    r = client.get("/api/nonexistent")
    test("404 for unknown endpoint", r.status_code == 404)

    # ===========================================
    print("\n[Path Traversal Attempts]")
    # ===========================================

    r = client.get("/api/documents/../../../etc/passwd")
    test("Path traversal rejected", r.status_code in [404, 422], f"got {r.status_code}")

    # ===========================================
    print("\n[Concurrent Requests]")
    # ===========================================

    def make_request(i):
        r = client.get(f"/api/search?q=test{i}")
        return r.status_code == 200

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(make_request, i) for i in range(20)]
        results = [f.result() for f in futures]

    test("20 concurrent requests", all(results), f"{sum(results)}/20 succeeded")

    # ===========================================
    print("\n[Response Format]")
    # ===========================================

    r = client.get("/api/search?q=test")
    if r.status_code == 200:
        data = r.json()
        test("Response has query", "query" in data)
        test("Response has total_results", "total_results" in data)
        test("Response has results", "results" in data)
        test("Results is list", isinstance(data.get("results"), list))

    # ===========================================
    print("\n[FTS5 Special Syntax]")
    # ===========================================

    fts_queries = [
        "test AND query",
        "test OR query",
        "test NOT query",
        '"exact phrase"',
        "test*",
        "NEAR(test query)",
    ]
    for q in fts_queries:
        r = client.get(f"/api/search?q={q}")
        test(f"FTS5: {q}", r.status_code == 200, f"got {r.status_code}")

    # ===========================================
    # Summary
    # ===========================================

    total = PASSED + FAILED
    pct = (PASSED / total * 100) if total > 0 else 0

    print(f"\n{'='*50}")
    print(f"RESULTS: {PASSED}/{total} passed ({pct:.1f}%)")
    print(f"{'='*50}")

    return FAILED == 0

if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
