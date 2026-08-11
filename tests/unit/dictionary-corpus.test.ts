import { describe, expect, it } from "vite-plus/test";
import {
  DICTIONARY_CORPUS_POINTER_KEY,
  dictionaryCorpusManifestKey,
  isDictionaryCorpusManifest,
  isDictionaryCorpusPointer,
} from "../../src/utils/dictionary-corpus";

describe("dictionary corpus pointer/manifest schema", () => {
  const digest = "ab".repeat(32);

  it("accepts a strict schema:1 pointer with 64-hex digest", () => {
    expect(
      isDictionaryCorpusPointer({
        schema: 1,
        dictionaryDigest: digest,
        manifestKey: dictionaryCorpusManifestKey(digest),
        fileCount: 3,
        totalBytes: 99,
      }),
    ).toBe(true);
  });

  it("rejects short digests, mismatched manifestKey, and wrong schema", () => {
    expect(
      isDictionaryCorpusPointer({
        schema: 1,
        dictionaryDigest: "short",
        manifestKey: dictionaryCorpusManifestKey("short"),
        fileCount: 0,
        totalBytes: 0,
      }),
    ).toBe(false);
    expect(
      isDictionaryCorpusPointer({
        schema: 1,
        dictionaryDigest: digest,
        manifestKey: "wrong-key",
        fileCount: 0,
        totalBytes: 0,
      }),
    ).toBe(false);
    expect(
      isDictionaryCorpusPointer({
        schema: 2,
        dictionaryDigest: digest,
        manifestKey: dictionaryCorpusManifestKey(digest),
        fileCount: 0,
        totalBytes: 0,
      }),
    ).toBe(false);
  });

  it("accepts a matching manifest and rejects count/digest mismatches", () => {
    const files = [
      { path: "pack/0.txt", sha256: "cd".repeat(32), bytes: 10 },
      { path: "a/index.json", sha256: "ef".repeat(32), bytes: 20 },
    ];
    expect(
      isDictionaryCorpusManifest({
        schema: 1,
        dictionaryDigest: digest,
        fileCount: 2,
        totalBytes: 30,
        files,
      }),
    ).toBe(true);
    expect(
      isDictionaryCorpusManifest({
        schema: 1,
        dictionaryDigest: digest,
        fileCount: 3,
        totalBytes: 30,
        files,
      }),
    ).toBe(false);
  });

  it("exports the stable pointer key", () => {
    expect(DICTIONARY_CORPUS_POINTER_KEY).toBe("dictionary-corpus/current.json");
  });
});
