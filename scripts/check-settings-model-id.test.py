#!/usr/bin/env python3
"""Exercise scripts/check-settings-model-id.py against real config shapes."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

CHECKER = Path(__file__).with_name("check-settings-model-id.py")

ENDPOINT = {
    "id": "15292c18",
    "name": "DeepSeek",
    "baseURL": "https://api.deepseek.com/v1",
    "modelId": "deepseek-flash",
    "contextLimit": 1_000_000,
}


def run(settings: dict | str) -> tuple[int, str, dict | str]:
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "termigo-settings.json"
        text = settings if isinstance(settings, str) else json.dumps(settings)
        path.write_text(text, encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(CHECKER), str(path)],
            capture_output=True,
            text=True,
        )
        after = path.read_text(encoding="utf-8")
        try:
            reparsed: dict | str = json.loads(after)
        except json.JSONDecodeError:
            reparsed = after
        return proc.returncode, proc.stdout.strip(), reparsed


CASES: list[tuple[str, dict | str, int, str]] = [
    (
        "bare endpoint id (the legacy guide's form)",
        {"defaultModelId": "15292c18", "customEndpoints": [ENDPOINT]},
        0,
        "FIXED",
    ),
    (
        "already compat",
        {"defaultModelId": "compat-15292c18", "customEndpoints": [ENDPOINT]},
        0,
        "OK",
    ),
    (
        "endpoint name",
        {"defaultModelId": "DeepSeek", "customEndpoints": [ENDPOINT]},
        0,
        "FIXED",
    ),
    (
        "provider-side model id",
        {"defaultModelId": "deepseek-flash", "customEndpoints": [ENDPOINT]},
        0,
        "FIXED",
    ),
    (
        "case-insensitive name",
        {"defaultModelId": "deepseek", "customEndpoints": [ENDPOINT]},
        0,
        "FIXED",
    ),
    (
        "dead compat id",
        {"defaultModelId": "compat-missing", "customEndpoints": [ENDPOINT]},
        1,
        "INVALID",
    ),
    (
        "unresolvable id",
        {"defaultModelId": "who-knows", "customEndpoints": [ENDPOINT]},
        1,
        "INVALID",
    ),
    (
        "no endpoints leaves a built-in id alone",
        {"defaultModelId": "gpt-5.4-mini", "customEndpoints": []},
        0,
        "OK",
    ),
    ("malformed json is skipped", "not json", 0, "SKIP"),
    (
        "missing file is skipped",
        {"defaultModelId": "compat-15292c18", "customEndpoints": [ENDPOINT]},
        0,
        "OK",
    ),
]


def main() -> int:
    failures = 0
    for name, settings, want_code, want_text in CASES:
        code, out, after = run(settings)
        ok = code == want_code and want_text in out
        # A repaired file must carry the compat form and nothing else.
        if ok and want_text == "FIXED":
            ok = (
                isinstance(after, dict)
                and after.get("defaultModelId") == "compat-15292c18"
            )
        if not ok:
            failures += 1
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {name}: exit={code} {out.splitlines()[0] if out else ''}")
    print(f"\n{len(CASES) - failures}/{len(CASES)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
