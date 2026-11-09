#!/usr/bin/env python3
"""Increment CACHE_VERSION in sw.js (vN → vN+1). Run before commit/push so the bump is in git."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SW_FILE = ROOT / "sw.js"

PATTERN = re.compile(r"(const CACHE_VERSION = ')v(\d+)(')")


def main() -> int:
    text = SW_FILE.read_text(encoding="utf-8")
    match = PATTERN.search(text)
    if not match:
        print(f"error: CACHE_VERSION not found in {SW_FILE}", file=sys.stderr)
        return 1
    old_n = int(match.group(2))
    new_n = old_n + 1
    new_text, count = PATTERN.subn(rf"\1v{new_n}\3", text, count=1)
    if count != 1:
        print("error: failed to replace CACHE_VERSION", file=sys.stderr)
        return 1
    SW_FILE.write_text(new_text, encoding="utf-8")
    print(f"CACHE_VERSION: v{old_n} → v{new_n} ({SW_FILE.relative_to(ROOT)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
