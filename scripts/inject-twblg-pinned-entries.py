#!/usr/bin/env python3
"""
Inject/verify explicitly pinned no-definition Taiwanese (ptck) pack entries
for titles that are NOT the general 詞目總檔.csv 屬性=2 (無義項音讀)
integration (see AGENTS.md「詞目總檔.csv」— that integration only appends a
heteronym to titles that ALREADY have a ptck pack record). This script
instead creates a brand-new single-heteronym pack record for a title with NO
pack record at all, but ONLY for titles individually pinned in
data/sources/twblg-overrides/pinned-no-definition.json, each backed by a
live official MOE sutian.moe.edu.tw citation recorded in that manifest.

This is intentionally NOT a bulk backfill of the ~500-680 twblg-headword-only
titles that are index-only today (g0v/moedict-webkit#271 audit) — doing that
without per-title verification would risk fabricating readings for titles
never actually confirmed against the official source. Each manifest entry is
a one-by-one, source-attributed exception; scripts/inject-twblg-variants.py
is the parallel precedent for "narrow injector reading a pinned upstream
manifest, editing ptck packs in place, byte-identical on untouched lines".

Generated shape (matches the existing `{"T":"...","d":[]}` no-definition
heteronym convention already established in the ptck corpus, e.g. 蛇's 文讀
siâ heteronym):

    "%u9577%u8932":{"h":[{"T":"tn̂g-khòo","d":[]}],"t":"`長~`褲~"}

Fields intentionally omitted: `_` (id — front-end treats lang=t `_` as an
audio-fallback id; no audio exists for a pinned no-definition entry), `=`
(audio_id), `reading` (文/白/俗/替 classification — the manifest source
records no such classification for this title). `T` is NFD-normalized at
write time regardless of manifest form, matching the `check:data` /
AGENTS.md「ptck 的 T 欄」NFD invariant. `t` (title) uses the SAME
backtick/tilde cross-reference markup (`` `X~ ``) every other multi-char
ptck title uses — verified directly against the real handler
(handleDictionaryAPI.decodeLangPart) on an existing definition-bearing
entry (管理): on the default `/api/{word}.json` route this markup becomes
per-character `<a href="./#...">` anchors in `body.title`, which IS the
established, universal API-observable contract for lang=t multi-char
titles — not a cosmetic on-disk-only convention a pinned entry can skip.

commands/upload_dictionary.sh syncs selected fixed runtime subfolders
under `data/dictionary` to R2 (PACK_FOLDERS/LANG_FOLDERS/search-index/
translation-data/lookup-pinyin) — an unlisted subfolder is silently never
uploaded. This provenance manifest is source/build metadata, not a runtime
dictionary object, so it deliberately lives outside data/dictionary
entirely, under data/sources/, for that ownership boundary.

Usage:
    # Mutating (writes new pack lines for any pinned entry missing from ptck):
    python3 scripts/inject-twblg-pinned-entries.py \\
        data/sources/twblg-overrides/pinned-no-definition.json \\
        data/dictionary/ptck [--dry-run]

    # Non-mutating verification (wired into `vp run check:data`):
    python3 scripts/inject-twblg-pinned-entries.py \\
        data/sources/twblg-overrides/pinned-no-definition.json \\
        data/dictionary/ptck --check

Idempotent: running the mutating form twice with the same manifest is a
no-op the second time. `--check` never writes; it fails (non-zero exit) if
any pinned entry is missing from its ptck bucket OR present with a value
that does not exactly match the manifest-derived expected value (title
markup, T reading, and d:[] all compared) — so silent drift in either
direction (deleted entry, hand-edited entry) is caught, not skipped.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import unicodedata


def bucket_of(title: str) -> int:
    """Mirror src/utils bucketOf() for lang='t': charCodeAt(0) % 128, with
    astral code points using the low surrogate minus 0xDC00 (same rule
    AGENTS.md documents for a/t/h/c bucketing)."""
    cp = ord(title[0])
    if cp > 0xFFFF:
        # Python str already holds the full code point; replicate the JS
        # UTF-16 low-surrogate arithmetic AGENTS.md specifies.
        cp -= 0x10000
        low_surrogate = 0xDC00 + (cp & 0x3FF)
        cp = low_surrogate - 0xDC00
    return cp % 128


def escape_key(title: str) -> str:
    """JS escape()-equivalent %uXXXX key encoding for a dictionary title."""
    out = []
    for ch in title:
        cp = ord(ch)
        if cp > 0xFFFF:
            cp -= 0x10000
            hi = 0xD800 + (cp >> 10)
            lo = 0xDC00 + (cp & 0x3FF)
            out.append("%%u%04X%%u%04X" % (hi, lo))
        else:
            out.append("%%u%04X" % cp)
    return "".join(out)


def markup_title(title: str) -> str:
    """Wrap each character in the backtick/tilde cross-reference markup
    (`` `X~ ``) every existing multi-char ptck `t` field uses. Verified via
    the real handler (handleDictionaryAPI.decodeLangPart): on the default
    /api/{word}.json route this markup becomes per-character
    `<a href="./#'X">X</a>` anchors in body.title — that is the ESTABLISHED
    API-observable contract for every multi-char lang=t entry (checked
    directly against an existing definition-bearing entry, 管理), not a
    cosmetic on-disk-only convention. A pinned entry must match it exactly
    so its API shape is indistinguishable from a normal multi-char record."""
    return "".join(f"`{ch}~" for ch in title)


def load_manifest(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        manifest = json.load(f)
    entries = manifest.get("entries", [])
    for entry in entries:
        for required_key in ("title", "T", "source_entry_url", "source_search_url"):
            if not entry.get(required_key):
                raise ValueError(f"Manifest entry missing {required_key!r}: {entry!r}")
    return entries


def parse_ptck_keys(raw_lines: list[str]) -> set[str]:
    keys: set[str] = set()
    for raw_line in raw_lines:
        s = raw_line.rstrip("\n")
        if s in ("{", "}", ""):
            continue
        s2 = s
        if s2.startswith("{"):
            s2 = s2[1:]
        if s2.endswith(","):
            s2 = s2[:-1]
        obj = json.loads("{" + s2 + "}")
        keys.add(next(iter(obj.keys())))
    return keys


def parse_ptck_entry(raw_lines: list[str], target_key: str) -> dict | None:
    """Return the parsed value for target_key if present in the file, else None."""
    for raw_line in raw_lines:
        s = raw_line.rstrip("\n")
        if s in ("{", "}", ""):
            continue
        s2 = s
        if s2.startswith("{"):
            s2 = s2[1:]
        if s2.endswith(","):
            s2 = s2[:-1]
        obj = json.loads("{" + s2 + "}")
        key = next(iter(obj.keys()))
        if key == target_key:
            return obj[key]
    return None


def format_entry_line(key: str, val: dict) -> str:
    key_json = json.dumps(key, ensure_ascii=False)
    val_json = json.dumps(val, ensure_ascii=False, separators=(",", ":"))
    return f'{key_json}:{val_json}'


def insert_sorted(raw_lines: list[str], key: str, val: dict) -> list[str]:
    """Insert a new entry line keeping the file's established
    ascending-key-order convention (verified: every existing ptck/*.txt is
    key-sorted). Preserves the file's leading `{` / trailing `,` skeleton
    convention exactly: only the very first content line owns the leading
    `{`; every content line except the last owns a trailing `,`."""
    # Split into (is_skeleton, key_or_none, raw_line)
    content_indices = [
        i for i, raw in enumerate(raw_lines) if raw.rstrip("\n") not in ("{", "}", "")
    ]
    if not content_indices:
        raise ValueError("ptck file has no content lines to anchor insertion against")

    keys_in_order = []
    for i in content_indices:
        s = raw_lines[i].rstrip("\n")
        s2 = s
        if s2.startswith("{"):
            s2 = s2[1:]
        if s2.endswith(","):
            s2 = s2[:-1]
        obj = json.loads("{" + s2 + "}")
        keys_in_order.append(next(iter(obj.keys())))

    insert_pos = len(content_indices)  # default: append at end (before last '}' skeleton line)
    for order_idx, existing_key in enumerate(keys_in_order):
        if existing_key > key:
            insert_pos = order_idx
            break

    new_line_body = format_entry_line(key, val)
    new_lines = list(raw_lines)

    if insert_pos == 0:
        # New entry becomes the first content line: it owns the leading '{',
        # and (unless it's also the only content line) gets a trailing ','.
        first_idx = content_indices[0]
        old_first_raw = new_lines[first_idx].rstrip("\n")
        # Strip old leading '{' from the previously-first line since the new
        # line now owns it.
        if old_first_raw.startswith("{"):
            new_lines[first_idx] = old_first_raw[1:] + "\n"
        trailing_comma = "," if len(content_indices) >= 1 else ""
        new_lines.insert(first_idx, "{" + new_line_body + trailing_comma + "\n")
    else:
        anchor_content_idx = content_indices[insert_pos - 1]
        # New entry is inserted after this anchor line; it always needs a
        # trailing comma unless it's now the last content line.
        is_last = insert_pos == len(content_indices)
        trailing_comma = "" if is_last else ","
        # If it becomes last, the previously-last content line (which had no
        # trailing comma) now needs one.
        if is_last:
            last_content_idx = content_indices[-1]
            old_last_raw = new_lines[last_content_idx].rstrip("\n")
            if not old_last_raw.endswith(","):
                new_lines[last_content_idx] = old_last_raw + ",\n"
        new_lines.insert(anchor_content_idx + 1, new_line_body + trailing_comma + "\n")

    return new_lines


def process_manifest_entry(entry: dict, ptck_dir: str, dry_run: bool, check_only: bool) -> dict:
    title = entry["title"]
    T_raw = entry["T"]
    T_nfd = unicodedata.normalize("NFD", T_raw)

    bucket = bucket_of(title)
    fname = f"{bucket}.txt"
    path = os.path.join(ptck_dir, fname)
    key = escape_key(title)

    with open(path, encoding="utf-8") as f:
        raw_lines = f.readlines()

    # Title uses the SAME backtick/tilde markup as every other multi-char
    # ptck title (single-char titles stay plain, matching existing
    # single-char entries): verified directly against handleDictionaryAPI's
    # real /api/{word}.json route output for an existing entry (管理) — this
    # is the established API-observable contract, not a cosmetic choice.
    expected_val = {
        "h": [{"T": T_nfd, "d": []}],
        "t": markup_title(title) if len(title) > 1 else title,
    }

    existing_val = parse_ptck_entry(raw_lines, key)
    if existing_val is not None:
        if existing_val == expected_val:
            return {"status": "ok-existing", "file": fname, "key": key, "title": title}
        return {
            "status": "mismatch",
            "file": fname,
            "key": key,
            "title": title,
            "expected": expected_val,
            "actual": existing_val,
        }

    if check_only:
        return {"status": "missing", "file": fname, "key": key, "title": title}

    new_lines = insert_sorted(raw_lines, key, expected_val)

    # Verify round-trip: every pre-existing content line's key survives
    # untouched, and the new key was added — correctness gate, not a debug
    # assertion, so it must run even under `python -O`.
    old_keys = parse_ptck_keys(raw_lines)
    new_keys = parse_ptck_keys(new_lines)
    if new_keys != old_keys | {key}:
        raise RuntimeError(
            f"Key set mismatch after insert in {fname}: "
            f"added={new_keys - old_keys}, missing={old_keys - new_keys}"
        )
    # Verify the whole new file still parses as one JSON object with the
    # exact expected value at the new key.
    combined = "".join(new_lines)
    parsed_whole = json.loads(combined)
    if key not in parsed_whole or parsed_whole[key] != expected_val:
        raise RuntimeError(f"Post-insert parse mismatch for {key} in {fname}")

    if not dry_run:
        with open(path, "w", encoding="utf-8") as f:
            f.writelines(new_lines)

    return {
        "status": "inserted",
        "file": fname,
        "key": key,
        "title": title,
        "T": T_nfd,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Inject/verify pinned no-definition ptck entries from a source-attributed manifest"
    )
    parser.add_argument("manifest_json", help="Path to pinned-no-definition.json")
    parser.add_argument("ptck_dir", help="Path to data/dictionary/ptck/")
    parser.add_argument("--dry-run", action="store_true", help="Report changes without writing")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Non-mutating: verify every pinned entry is present with the exact "
        "expected value. Exits non-zero on any missing or mismatched entry. "
        "Never writes files (implies --dry-run semantics).",
    )
    args = parser.parse_args()

    entries = load_manifest(args.manifest_json)
    print(
        f"Loaded {len(entries)} pinned entr{'y' if len(entries) == 1 else 'ies'} "
        f"from {args.manifest_json}"
    )

    inserted = 0
    ok_existing = 0
    missing = 0
    mismatched = 0
    for entry in entries:
        result = process_manifest_entry(entry, args.ptck_dir, args.dry_run, args.check)
        tag = "[DRY]" if args.dry_run else "[WRITE]"
        if result["status"] == "inserted":
            inserted += 1
            print(
                f"  {tag} {result['file']}: inserted {result['key']} "
                f"(title={result['title']!r}, T={result['T']!r})"
            )
        elif result["status"] == "ok-existing":
            ok_existing += 1
            print(f"  [OK] {result['file']}: {result['key']} matches pinned value")
        elif result["status"] == "missing":
            missing += 1
            print(f"  [MISSING] {result['file']}: {result['key']} not present in pack")
        else:  # mismatch
            mismatched += 1
            print(
                f"  [MISMATCH] {result['file']}: {result['key']} present but differs "
                f"from pinned value\n"
                f"    expected: {json.dumps(result['expected'], ensure_ascii=False)}\n"
                f"    actual:   {json.dumps(result['actual'], ensure_ascii=False)}"
            )

    print("\nSummary:")
    print(f"  Manifest entries:  {len(entries)}")
    print(f"  Inserted:          {inserted}")
    print(f"  Already correct:   {ok_existing}")
    print(f"  Missing:           {missing}")
    print(f"  Mismatched:        {mismatched}")
    if args.dry_run and not args.check:
        print("\n[DRY RUN — no files written]")

    check_missing_fail = args.check and missing > 0
    if mismatched > 0 or check_missing_fail:
        print(
            f"\n[inject-twblg-pinned-entries] FAIL: {missing} missing "
            f"(fatal={check_missing_fail}), {mismatched} mismatched pinned "
            f"entr{'y' if (missing + mismatched) == 1 else 'ies'}."
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
