/**
 * Dictionary corpus pointer/manifest schema for **upload-driven cache busting**.
 *
 * Unlike the stroke-corpus atomic model, dictionary uploads still overwrite
 * flat R2 keys in place (`pack/*`, `a/*`, …). The pointer's 64-hex digest is
 * a hash of the uploaded-object inventory used only to namespace
 * `caches.default` keys and the per-isolate pack memo. `dictionary-corpora/<digest>/`
 * currently stores the inventory manifest only — the Worker never reads corpus
 * objects from that prefix. Reverting the pointer does not restore old bytes.
 */
export const DICTIONARY_CORPUS_POINTER_KEY = "dictionary-corpus/current.json";
export const DICTIONARY_CORPUS_PREFIX = "dictionary-corpora";

export interface DictionaryCorpusFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface DictionaryCorpusManifest {
  schema: 1;
  dictionaryDigest: string;
  fileCount: number;
  totalBytes: number;
  files: DictionaryCorpusFile[];
}

export interface DictionaryCorpusPointer {
  schema: 1;
  dictionaryDigest: string;
  manifestKey: string;
  fileCount: number;
  totalBytes: number;
}

export function dictionaryCorpusManifestKey(dictionaryDigest: string): string {
  return `${DICTIONARY_CORPUS_PREFIX}/${dictionaryDigest}/manifest.json`;
}

export function isDictionaryCorpusPointer(value: unknown): value is DictionaryCorpusPointer {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.schema === 1 &&
    typeof v.dictionaryDigest === "string" &&
    /^[a-f0-9]{64}$/i.test(v.dictionaryDigest) &&
    typeof v.manifestKey === "string" &&
    v.manifestKey === dictionaryCorpusManifestKey(v.dictionaryDigest) &&
    Number.isInteger(v.fileCount) &&
    (v.fileCount as number) >= 0 &&
    Number.isInteger(v.totalBytes) &&
    (v.totalBytes as number) >= 0
  );
}

export function isDictionaryCorpusManifest(value: unknown): value is DictionaryCorpusManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.schema !== 1 || typeof v.dictionaryDigest !== "string" || !Array.isArray(v.files)) {
    return false;
  }
  if (!/^[a-f0-9]{64}$/i.test(v.dictionaryDigest) || v.fileCount !== v.files.length) {
    return false;
  }
  if (typeof v.totalBytes !== "number" || !Number.isInteger(v.totalBytes) || v.totalBytes < 0) {
    return false;
  }
  return v.files.every((f) => {
    if (!f || typeof f !== "object") return false;
    const file = f as Record<string, unknown>;
    return (
      typeof file.path === "string" &&
      file.path.length > 0 &&
      typeof file.sha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(file.sha256) &&
      typeof file.bytes === "number" &&
      Number.isInteger(file.bytes) &&
      file.bytes >= 0
    );
  });
}
