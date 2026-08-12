#!/usr/bin/env python3
"""Shared hard request ceilings for read-only production QA tools."""

from __future__ import annotations

import dataclasses
import threading


class RequestBudgetExceeded(RuntimeError):
    """Raised before a QA tool would exceed its configured request ceiling."""


@dataclasses.dataclass
class RequestBudget:
    limit: int
    used: int = 0
    _lock: threading.Lock = dataclasses.field(
        default_factory=threading.Lock,
        init=False,
        repr=False,
        compare=False,
    )

    def __post_init__(self) -> None:
        if self.limit < 0:
            raise ValueError("request budget cannot be negative")
        if self.used < 0 or self.used > self.limit:
            raise ValueError("used requests must be within the request budget")

    @property
    def remaining(self) -> int:
        with self._lock:
            return self.limit - self.used

    def consume(self, label: str, count: int = 1) -> None:
        if count < 1:
            raise ValueError("request count must be positive")
        with self._lock:
            if self.used + count > self.limit:
                raise RequestBudgetExceeded(
                    f"request budget exhausted before {label}: "
                    f"used {self.used} of {self.limit}"
                )
            self.used += count

    def ensure_available(self, count: int, label: str) -> None:
        if count < 0:
            raise ValueError("required request count cannot be negative")
        with self._lock:
            if count > self.limit - self.used:
                raise RequestBudgetExceeded(
                    f"{label} needs at least {count} more requests, but only "
                    f"{self.limit - self.used} remain in the {self.limit}-request budget"
                )
