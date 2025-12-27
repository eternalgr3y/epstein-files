"""
Security middleware and utilities for Epstein Files API.

Provides:
- Request logging with abuse detection
- Input sanitization
- Suspicious pattern detection
- IP blocking for repeat offenders
"""

import re
import time
import hashlib
import logging
from typing import Optional, Set, Dict
from collections import defaultdict
from datetime import datetime, timedelta
from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
import threading

logger = logging.getLogger(__name__)

# =============================================================================
# CONFIGURATION
# =============================================================================

# Suspicious patterns that might indicate automated attacks
SUSPICIOUS_PATTERNS = [
    r'(?i)(union\s+select|insert\s+into|drop\s+table|delete\s+from)',  # SQL
    r'(?i)(<script|javascript:|on\w+\s*=)',  # XSS
    r'(?i)(\.\.\/|\.\.\\|etc\/passwd|\/etc\/shadow)',  # Path traversal
    r'(?i)(cmd\.exe|\/bin\/sh|\/bin\/bash)',  # Command injection
    r'(?i)(base64_decode|eval\s*\(|exec\s*\()',  # Code injection
]

# Compiled patterns for performance
COMPILED_PATTERNS = [re.compile(p) for p in SUSPICIOUS_PATTERNS]

# Known scanner user agents
SCANNER_AGENTS = [
    'sqlmap', 'nikto', 'nmap', 'masscan', 'zgrab', 'gobuster',
    'dirbuster', 'wfuzz', 'hydra', 'burp', 'owasp', 'acunetix',
]

# =============================================================================
# ABUSE TRACKING
# =============================================================================

class AbuseTracker:
    """Track and block abusive IPs."""

    def __init__(self,
                 block_threshold: int = 10,
                 block_duration_minutes: int = 60,
                 window_minutes: int = 5):
        self.block_threshold = block_threshold
        self.block_duration = timedelta(minutes=block_duration_minutes)
        self.window = timedelta(minutes=window_minutes)

        self.violations: Dict[str, list] = defaultdict(list)
        self.blocked: Dict[str, datetime] = {}
        self.lock = threading.Lock()

    def record_violation(self, ip: str, reason: str) -> bool:
        """Record a violation. Returns True if IP is now blocked."""
        with self.lock:
            now = datetime.now()

            # Clean old violations
            cutoff = now - self.window
            self.violations[ip] = [v for v in self.violations[ip] if v[0] > cutoff]

            # Add new violation
            self.violations[ip].append((now, reason))
            logger.warning(f"Security violation from {ip}: {reason}")

            # Check if should block
            if len(self.violations[ip]) >= self.block_threshold:
                self.blocked[ip] = now
                logger.error(f"Blocked IP {ip} for {self.block_duration.seconds//60} minutes")
                return True

            return False

    def is_blocked(self, ip: str) -> bool:
        """Check if an IP is currently blocked."""
        with self.lock:
            if ip not in self.blocked:
                return False

            # Check if block has expired
            if datetime.now() - self.blocked[ip] > self.block_duration:
                del self.blocked[ip]
                return False

            return True

    def get_stats(self) -> Dict:
        """Get abuse tracking statistics."""
        with self.lock:
            return {
                "active_violators": len(self.violations),
                "blocked_ips": len(self.blocked),
                "block_threshold": self.block_threshold,
                "block_duration_minutes": self.block_duration.seconds // 60,
            }


# Global tracker
abuse_tracker = AbuseTracker()


# =============================================================================
# INPUT SANITIZATION
# =============================================================================

def sanitize_input(value: str, max_length: int = 500) -> str:
    """Sanitize user input."""
    if not value:
        return value

    # Truncate
    value = value[:max_length]

    # Remove null bytes
    value = value.replace('\x00', '')

    # Normalize whitespace
    value = ' '.join(value.split())

    return value


def is_suspicious(value: str) -> Optional[str]:
    """Check if input contains suspicious patterns. Returns reason if suspicious."""
    if not value:
        return None

    for pattern in COMPILED_PATTERNS:
        if pattern.search(value):
            return f"Pattern match: {pattern.pattern[:30]}..."

    return None


def is_scanner_agent(user_agent: str) -> bool:
    """Check if user agent looks like a security scanner."""
    if not user_agent:
        return False

    ua_lower = user_agent.lower()
    return any(scanner in ua_lower for scanner in SCANNER_AGENTS)


# =============================================================================
# REQUEST LOGGING
# =============================================================================

class RequestLog:
    """Simple request logger with rotation."""

    def __init__(self, max_entries: int = 10000):
        self.max_entries = max_entries
        self.entries: list = []
        self.lock = threading.Lock()

    def log(self, entry: Dict):
        with self.lock:
            self.entries.append(entry)
            if len(self.entries) > self.max_entries:
                self.entries = self.entries[-self.max_entries:]

    def get_recent(self, count: int = 100) -> list:
        with self.lock:
            return self.entries[-count:]

    def get_by_ip(self, ip: str, count: int = 50) -> list:
        with self.lock:
            return [e for e in self.entries if e.get('ip') == ip][-count:]


request_log = RequestLog()


# =============================================================================
# SECURITY MIDDLEWARE
# =============================================================================

class SecurityMiddleware(BaseHTTPMiddleware):
    """Security middleware for request validation and logging."""

    async def dispatch(self, request: Request, call_next):
        start_time = time.time()

        # Get client IP
        ip = request.client.host if request.client else "unknown"
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            ip = forwarded.split(",")[0].strip()

        # Check if IP is blocked
        if abuse_tracker.is_blocked(ip):
            logger.warning(f"Blocked request from {ip}")
            return JSONResponse(
                status_code=403,
                content={"detail": "Access denied"}
            )

        # Check user agent
        user_agent = request.headers.get("user-agent", "")
        if is_scanner_agent(user_agent):
            abuse_tracker.record_violation(ip, f"Scanner detected: {user_agent[:50]}")

        # Check query parameters for suspicious content
        for key, value in request.query_params.items():
            reason = is_suspicious(value)
            if reason:
                if abuse_tracker.record_violation(ip, reason):
                    return JSONResponse(
                        status_code=403,
                        content={"detail": "Access denied"}
                    )

        # Process request
        try:
            response = await call_next(request)
        except Exception as e:
            logger.error(f"Request error from {ip}: {e}")
            raise

        # Calculate duration
        duration = time.time() - start_time

        # Log request (skip static files and health checks)
        path = request.url.path
        if not path.startswith("/static") and path != "/health":
            request_log.log({
                "timestamp": datetime.now().isoformat(),
                "ip": ip,
                "method": request.method,
                "path": path,
                "query": str(request.query_params),
                "status": response.status_code,
                "duration_ms": round(duration * 1000, 2),
                "user_agent": user_agent[:100] if user_agent else None,
            })

        # Log slow requests
        if duration > 5.0:
            logger.warning(f"Slow request: {path} took {duration:.2f}s from {ip}")

        return response


# =============================================================================
# HONEYPOT ENDPOINTS
# =============================================================================

# Paths that legitimate users would never access
HONEYPOT_PATHS = {
    "/admin", "/wp-admin", "/phpmyadmin", "/.env", "/config.php",
    "/wp-login.php", "/.git/config", "/backup.sql", "/db.sql",
    "/xmlrpc.php", "/admin.php", "/.htaccess", "/server-status",
}

def is_honeypot_path(path: str) -> bool:
    """Check if path is a honeypot."""
    return path.lower() in HONEYPOT_PATHS or path.lower().startswith(("/wp-", "/admin"))
