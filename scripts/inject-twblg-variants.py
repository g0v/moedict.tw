#!/usr/bin/env python3
"""
Inject TWBLG 異用字 (alternate character forms) B field into existing ptck packs.

Source: g0v/moedict-data-twblg x-異用字.json
Commit: 437588d47372b94e636f59cf0c33f350a49c2277
Blob SHA1: 860d76d20570cfa19719113923475f80fe04cede
SHA-256:   aa5b0a41823c7cf44dcf532716629f4db3228aa58c7428ddc0accb40f2c9997a
License:   CC BY-ND 3.0 TW (教育部臺灣閩南語常用詞辭典)

Strategy: incremental, in-place line-by-line. Each non-skeleton line in a ptck
file is parsed as a single JSON entry; heteronyms matching a 主編碼 (_) in the
variants map receive a B field (NFD-normalized string[]). All other bytes are
preserved exactly via json.dumps(ensure_ascii=False, separators=(',', ':')),
which is proven byte-identical to the pack generator's output for untouched records.

The =.txt file (vernacular synonym index, different schema) is skipped.

Usage:
    python3 scripts/inject-twblg-variants.py <variants.json> <ptck_dir> [--dry-run]

Reports:
    - mapped IDs (id present in both variants map and ptck)
    - orphan IDs (id in variants map but no matching heteronym in ptck)
    - changed files and heteronym count
"""

import argparse
import hashlib
import json
import os
import sys
import unicodedata

SKIP_FILES = {'=.txt'}


def load_variants(path: str) -> dict[str, list[str]]:
    with open(path, encoding='utf-8') as f:
        raw = f.read()
    data = json.loads(raw)
    # Validate schema: string -> list[str]
    for k, v in data.items():
        if not isinstance(k, str):
            raise ValueError(f"Non-string key: {k!r}")
        if not isinstance(v, list) or not all(isinstance(s, str) for s in v):
            raise ValueError(f"Non-string[] value for key {k!r}: {v!r}")
    # Audit NFD invariant on upstream bytes before any normalization.
    # Han ideographs are typically NFD-stable, but we must not assume.
    total_strings = sum(len(vs) for vs in data.values())
    non_nfd = [
        (k, v)
        for k, vs in data.items()
        for v in vs
        if unicodedata.normalize('NFD', v) != v
    ]
    print(f'NFD audit: {total_strings} variant strings, '
          f'{len(non_nfd)} required normalization '
          f'({"NONE — all already NFD" if not non_nfd else "see below"})')
    for k, v in non_nfd[:10]:
        nfd = unicodedata.normalize('NFD', v)
        print(f'  id={k}  original={v!r}  nfd={nfd!r}')
    return data


def parse_ptck_line(raw_line: str) -> tuple[str, str, dict | None]:
    """Return (key, stripped_content, parsed_value_or_None).

    stripped_content is the line stripped of leading '{' and trailing ','.
    parsed_value is the heteronym dict, or None if the line is a skeleton line
    ({, }, or empty).
    """
    s = raw_line.rstrip('\n')
    if s in ('{', '}', ''):
        return ('', s, None)
    # Strip leading { (first line of file) and trailing , (all but last entry)
    has_open_brace = s.startswith('{')
    has_trailing_comma = s.endswith(',')
    if has_open_brace:
        s = s[1:]
    if has_trailing_comma:
        s = s[:-1]
    obj = json.loads('{' + s + '}')
    key = list(obj.keys())[0]
    val = obj[key]
    return (key, s, val)


def inject_variants_into_entry(val: dict, variants_map: dict[str, list[str]]) -> tuple[dict, int]:
    """Inject B field into heteronyms. Returns (modified_val, count_of_changed_heteronyms)."""
    changed = 0
    heteronyms = val.get('h')
    if not isinstance(heteronyms, list):
        return val, 0
    for heteronym in heteronyms:
        if not isinstance(heteronym, dict):
            continue
        id_ = heteronym.get('_')
        if not isinstance(id_, str):
            continue
        variants = variants_map.get(id_)
        if not variants:
            continue
        # NFD-normalize each variant string. Upstream is audited to already be
        # NFD for all current entries, but normalize defensively and then assert
        # the invariant holds on every value we are about to write.
        normalized = [unicodedata.normalize('NFD', v) for v in variants if isinstance(v, str) and v]
        if not normalized:
            continue
        for v in normalized:
            assert unicodedata.normalize('NFD', v) == v, (
                f"Post-normalization NFD invariant violated for id={id_!r}: {v!r}"
            )
        heteronym['B'] = normalized
        changed += 1
    return val, changed


def format_line(key: str, val: dict, has_open_brace: bool, has_trailing_comma: bool) -> str:
    key_json = json.dumps(key, ensure_ascii=False)
    val_json = json.dumps(val, ensure_ascii=False, separators=(',', ':'))
    line = f'{key_json}:{val_json}'
    if has_open_brace:
        line = '{' + line
    if has_trailing_comma:
        line = line + ','
    return line + '\n'


def process_file(path: str, variants_map: dict[str, list[str]], dry_run: bool) -> dict:
    """Process one ptck file. Returns stats dict."""
    with open(path, encoding='utf-8') as f:
        raw_lines = f.readlines()

    new_lines = []
    mapped_ids: list[str] = []
    heteronyms_changed = 0
    file_changed = False

    for i, raw_line in enumerate(raw_lines):
        s = raw_line.rstrip('\n')
        if s in ('{', '}', ''):
            new_lines.append(raw_line)
            continue

        has_open_brace = s.startswith('{')
        has_trailing_comma = s.endswith(',')
        stripped = s
        if has_open_brace:
            stripped = stripped[1:]
        if has_trailing_comma:
            stripped = stripped[:-1]

        obj = json.loads('{' + stripped + '}')
        key = list(obj.keys())[0]
        val = obj[key]

        modified_val, changed = inject_variants_into_entry(val, variants_map)

        if changed > 0:
            heteronyms_changed += changed
            # Collect which ids were mapped
            for h in (val.get('h') or []):
                if isinstance(h, dict) and h.get('_') in variants_map:
                    mapped_ids.append(h['_'])

            new_line = format_line(key, modified_val, has_open_brace, has_trailing_comma)
            new_lines.append(new_line)
            file_changed = True
        else:
            # Verify roundtrip is byte-identical for untouched lines
            val_json = json.dumps(val, ensure_ascii=False, separators=(',', ':'))
            key_json = json.dumps(key, ensure_ascii=False)
            expected_stripped = f'{key_json}:{val_json}'
            assert expected_stripped == stripped, (
                f"Roundtrip mismatch in {path} line {i}: "
                f"got {val_json[:80]!r}"
            )
            new_lines.append(raw_line)

    if file_changed and not dry_run:
        new_content = ''.join(new_lines)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new_content)

    return {
        'changed': file_changed,
        'heteronyms_changed': heteronyms_changed,
        'mapped_ids': mapped_ids,
    }


def main():
    parser = argparse.ArgumentParser(description='Inject TWBLG 異用字 B field into ptck packs')
    parser.add_argument('variants_json', help='Path to x-異用字.json')
    parser.add_argument('ptck_dir', help='Path to data/dictionary/ptck/')
    parser.add_argument('--dry-run', action='store_true', help='Report changes without writing')
    args = parser.parse_args()

    # Verify the variants file by SHA-256
    with open(args.variants_json, 'rb') as f:
        raw_bytes = f.read()
    sha256 = hashlib.sha256(raw_bytes).hexdigest()
    EXPECTED_SHA256 = 'aa5b0a41823c7cf44dcf532716629f4db3228aa58c7428ddc0accb40f2c9997a'
    if sha256 != EXPECTED_SHA256:
        print(f'WARNING: SHA-256 mismatch. Got {sha256}, expected {EXPECTED_SHA256}', file=sys.stderr)
        print('Proceeding anyway (pinned source may have been updated).', file=sys.stderr)

    variants_map = load_variants(args.variants_json)
    print(f'Loaded {len(variants_map)} variant entries from {args.variants_json}')

    all_mapped_ids: set[str] = set()
    total_heteronyms_changed = 0
    changed_files: list[str] = []

    ptck_files = sorted(f for f in os.listdir(args.ptck_dir) if f not in SKIP_FILES)
    for fname in ptck_files:
        path = os.path.join(args.ptck_dir, fname)
        stats = process_file(path, variants_map, args.dry_run)
        if stats['changed']:
            changed_files.append(fname)
            all_mapped_ids.update(stats['mapped_ids'])
            total_heteronyms_changed += stats['heteronyms_changed']
            print(f'  {"[DRY]" if args.dry_run else "[MODIFIED]"} {fname}: '
                  f'{stats["heteronyms_changed"]} heteronym(s) updated, '
                  f'ids={stats["mapped_ids"]}')

    orphan_ids = set(variants_map.keys()) - all_mapped_ids
    print(f'\nSummary:')
    print(f'  Files changed:          {len(changed_files)}')
    print(f'  Heteronyms updated:     {total_heteronyms_changed}')
    print(f'  Variant map entries:    {len(variants_map)}')
    print(f'  Mapped IDs (in ptck):   {len(all_mapped_ids)}')
    print(f'  Orphan IDs (not found): {len(orphan_ids)}')
    if args.dry_run:
        print('\n[DRY RUN — no files written]')
    else:
        print(f'\nWrote {len(changed_files)} file(s).')


if __name__ == '__main__':
    main()
