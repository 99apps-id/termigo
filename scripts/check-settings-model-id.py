#!/usr/bin/env python3
"""Validate (and repair) the model id in a Termigo settings file.

An OpenAI-compatible endpoint is addressed in the app by a synthetic model id:

    customEndpoints[].id = "15292c18"  ->  defaultModelId = "compat-15292c18"

A hand-written config usually carries the bare endpoint id instead (that is
what the deployment guide used to document), or the endpoint's name, or the
model id the provider itself expects. The app cannot resolve those, so it fell
back to a built-in model with no key - the service started, connected to
Telegram, and then never answered.

This accepts every one of those forms and rewrites the file to the stored
`compat-<id>` form, so a legacy config keeps working instead of silently
booting to the wrong model.

Exit codes:
  0  the file is usable (optionally after being repaired), or absent/unreadable
  1  the id cannot be resolved and the service must not start on it
  2  usage error

Usage: check-settings-model-id.py <path-to-termigo-settings.json>
"""

from __future__ import annotations

import json
import sys


def compat_id(endpoint_id: str) -> str:
    return f"compat-{endpoint_id}"


def endpoints_of(settings: dict) -> list[dict]:
    raw = settings.get("customEndpoints", [])
    if not isinstance(raw, list):
        return []
    return [
        e
        for e in raw
        if isinstance(e, dict) and str(e.get("id", "") or "").strip()
    ]


def resolve(default_model_id: str, endpoints: list[dict]) -> str | None:
    """Map any accepted form to the stored `compat-<id>` form, or None.

    Endpoints are checked first: if the string names a configured endpoint, that
    is what the user meant, even when a built-in model happens to be served
    under the same id (e.g. `deepseek-flash`).
    """
    if not default_model_id:
        return None
    lowered = default_model_id.lower()
    for ep in endpoints:
        endpoint_id = str(ep["id"]).strip()
        name = str(ep.get("name", "") or "").strip().lower()
        model_id = str(ep.get("modelId", "") or "").strip().lower()
        if default_model_id in (compat_id(endpoint_id), endpoint_id):
            return compat_id(endpoint_id)
        if lowered and lowered in {name, model_id}:
            return compat_id(endpoint_id)
    return None


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: check-settings-model-id.py <settings.json>")
        return 2
    path = argv[1]
    try:
        with open(path, encoding="utf-8") as handle:
            settings = json.load(handle)
    except FileNotFoundError:
        print(f"SKIP: {path} not found")
        return 0
    except Exception as exc:  # noqa: BLE001 - report and let the caller decide
        print(f"SKIP: cannot read {path}: {exc}")
        return 0

    if not isinstance(settings, dict):
        print(f"SKIP: {path} is not a JSON object")
        return 0

    endpoints = endpoints_of(settings)
    raw = str(settings.get("defaultModelId", "") or "").strip()

    # No endpoints configured: the id must be a built-in registry id, or unset.
    # Nothing here can verify the registry, so this is left to the app.
    if not endpoints:
        print(f"OK: defaultModelId={raw!r} (no custom endpoints)")
        return 0

    resolved = resolve(raw, endpoints)
    valid = [compat_id(str(e["id"]).strip()) for e in endpoints]

    if resolved is None:
        print(f"INVALID: defaultModelId={raw!r} matches no custom endpoint")
        print(f"Valid ids: {valid[:5]}")
        return 1

    if resolved != raw:
        settings["defaultModelId"] = resolved
        try:
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(settings, handle, indent=2)
                handle.write("\n")
        except Exception as exc:  # noqa: BLE001
            # The id is resolvable; a read-only file is not a reason to refuse
            # to start, only to say the repair did not stick.
            print(f"WARN: defaultModelId={raw!r} resolves to {resolved!r} but "
                  f"the file could not be rewritten: {exc}")
            return 0
        print(f"FIXED: defaultModelId {raw!r} -> {resolved!r}")
        return 0

    print(f"OK: defaultModelId={resolved!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
