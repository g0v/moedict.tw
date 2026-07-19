import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
VARIANT_SOURCE = ROOT / "data/sources/twblg-overrides/x-異用字.json"
VARIANT_INJECTOR = ROOT / "scripts/inject-twblg-variants.py"
PIN_INJECTOR = ROOT / "scripts/inject-twblg-pinned-entries.py"


def run_python(script, *args):
    return subprocess.run(
        ["python3", str(script), *map(str, args)],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


class PinnedInjectorTests(unittest.TestCase):
    def make_fixture(self, entries):
        tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(tmp.name)
        pack = root / "ptck"
        pack.mkdir()
        lines = ["{\n"]
        for index, (key, value) in enumerate(entries):
            suffix = ",\n" if index < len(entries) - 1 else "\n"
            lines.append(f'{json.dumps(key, ensure_ascii=False)}:{json.dumps(value, ensure_ascii=False, separators=(",", ":"))}{suffix}')
        lines.append("}\n")
        (pack / "66.txt").write_text("".join(lines), encoding="utf-8")
        manifest = root / "manifest.json"
        manifest.write_text(json.dumps({"entries": []}), encoding="utf-8")
        return tmp, root, pack, manifest

    def manifest_entry(self, title):
        return {"title": title, "T": "ā", "source_entry_url": "https://sutian.moe.edu.tw/entry", "source_search_url": "https://sutian.moe.edu.tw/tshiau/?lui=tai俗"}

    def test_head_insertion_is_sorted_and_exact(self):
        tmp, root, pack, manifest = self.make_fixture([("%u0041", {"t": "A"}), ("%u0043", {"t": "C"})])
        with tmp:
            manifest.write_text(json.dumps({"entries": [self.manifest_entry("B")]}, ensure_ascii=False))
            result = run_python(PIN_INJECTOR, manifest, pack)
            self.assertEqual(result.returncode, 0, result.stderr)
            text = (pack / "66.txt").read_text()
            self.assertLess(text.index("%u0041"), text.index("%u0042"))
            self.assertIn('"T":"ā","d":[]', text)

    def test_tail_insertion_and_second_run_are_byte_identical(self):
        tmp, root, pack, manifest = self.make_fixture([("%u0040", {"t": "@"}), ("%u0041", {"t": "A"})])
        with tmp:
            manifest.write_text(json.dumps({"entries": [self.manifest_entry("B")]}, ensure_ascii=False))
            self.assertEqual(run_python(PIN_INJECTOR, manifest, pack).returncode, 0)
            first = (pack / "66.txt").read_bytes()
            self.assertGreater(first.index(b"%u0042"), first.index(b"%u0041"))
            self.assertEqual(run_python(PIN_INJECTOR, manifest, pack).returncode, 0)
            self.assertEqual(first, (pack / "66.txt").read_bytes())

    def test_pinned_check_missing_and_tampered_fail(self):
        tmp, root, pack, manifest = self.make_fixture([("%u0041", {"t": "A"}), ("%u0043", {"t": "C"})])
        with tmp:
            entry = self.manifest_entry("B")
            manifest.write_text(json.dumps({"entries": [entry]}, ensure_ascii=False))
            self.assertNotEqual(run_python(PIN_INJECTOR, manifest, pack, "--check").returncode, 0)
            self.assertEqual(run_python(PIN_INJECTOR, manifest, pack).returncode, 0)
            path = pack / "66.txt"
            path.write_text(path.read_text().replace('"d":[]', '"d":[{"f":"tampered"}]'), encoding="utf-8")
            self.assertNotEqual(run_python(PIN_INJECTOR, manifest, pack, "--check").returncode, 0)

    def test_invalid_pinned_manifest_fails(self):
        tmp, root, pack, manifest = self.make_fixture([("%u0041", {"t": "A"})])
        with tmp:
            manifest.write_text('{"entries":[{"title":"B"}]}')
            self.assertNotEqual(run_python(PIN_INJECTOR, manifest, pack, "--check").returncode, 0)


class VariantInjectorTests(unittest.TestCase):
    def test_expected_b_is_inserted_for_real_id(self):
        variants = json.loads(VARIANT_SOURCE.read_text(encoding="utf-8"))
        ident, expected = next(iter(variants.items()))
        with tempfile.TemporaryDirectory() as td:
            pack = pathlib.Path(td) / "ptck"
            pack.mkdir()
            (pack / "0.txt").write_text('"%u0041":' + json.dumps({"h": [{"_": ident}]}) + "\n", encoding="utf-8")
            result = run_python(VARIANT_INJECTOR, VARIANT_SOURCE, pack)
            self.assertEqual(result.returncode, 0, result.stderr)
            parsed = json.loads("{" + (pack / "0.txt").read_text() + "}")
            self.assertEqual(parsed["%u0041"]["h"][0]["B"], expected)

    def test_check_detects_missing_and_tampered_b(self):
        variants = json.loads(VARIANT_SOURCE.read_text(encoding="utf-8"))
        ident, _ = next(iter(variants.items()))
        with tempfile.TemporaryDirectory() as td:
            pack = pathlib.Path(td) / "ptck"
            pack.mkdir()
            path = pack / "0.txt"
            path.write_text('"%u0041":' + json.dumps({"h": [{"_": ident, "B": ["wrong"]}]}) + "\n")
            result = run_python(VARIANT_INJECTOR, VARIANT_SOURCE, pack, "--check")
            self.assertNotEqual(result.returncode, 0)
            path.write_text('"%u0041":' + json.dumps({"h": [{"_": ident}]}) + "\n")
            result = run_python(VARIANT_INJECTOR, VARIANT_SOURCE, pack, "--check")
            self.assertNotEqual(result.returncode, 0)

    def test_variant_invalid_source_and_dry_run(self):
        with tempfile.TemporaryDirectory() as td:
            pack = pathlib.Path(td) / "ptck"
            pack.mkdir()
            path = pack / "0.txt"
            path.write_text('"%u0041":{}\n')
            bad = pathlib.Path(td) / "bad.json"
            bad.write_text("not json")
            self.assertNotEqual(run_python(VARIANT_INJECTOR, bad, pack, "--check").returncode, 0)
            before = path.read_bytes()
            result = run_python(VARIANT_INJECTOR, VARIANT_SOURCE, pack, "--dry-run")
            self.assertEqual(result.returncode, 0)
            self.assertEqual(before, path.read_bytes())


if __name__ == "__main__":
    unittest.main()
