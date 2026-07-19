export const STROKE_CORPUS_POINTER_KEY = "stroke-corpus/current.json";
export const STROKE_CORPUS_PREFIX = "stroke-corpora";
export const STROKE_CORPUS_EXPECTED_COUNT = 6063;

export interface StrokeCorpusFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface StrokeCorpusManifest {
  schema: 1;
  corpusDigest: string;
  fileCount: number;
  totalBytes: number;
  files: StrokeCorpusFile[];
}

export interface StrokeCorpusPointer {
  schema: 1;
  corpusDigest: string;
  manifestKey: string;
  fileCount: number;
  totalBytes: number;
}

export function strokeCorpusManifestKey(corpusDigest: string): string {
  return `${STROKE_CORPUS_PREFIX}/${corpusDigest}/manifest.json`;
}

export function strokeCorpusObjectKey(corpusDigest: string, codepoint: string): string {
  return `${STROKE_CORPUS_PREFIX}/${corpusDigest}/stroke-json/${codepoint.toLowerCase()}.json`;
}

export function isStrokeCorpusPointer(value: unknown): value is StrokeCorpusPointer {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.schema === 1 &&
    typeof v.corpusDigest === "string" &&
    /^[a-f0-9]{64}$/i.test(v.corpusDigest) &&
    typeof v.manifestKey === "string" &&
    v.manifestKey === strokeCorpusManifestKey(v.corpusDigest) &&
    Number.isInteger(v.fileCount) &&
    Number.isInteger(v.totalBytes)
  );
}

export function isStrokeCorpusManifest(value: unknown): value is StrokeCorpusManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.schema !== 1 || typeof v.corpusDigest !== "string" || !Array.isArray(v.files)) return false;
  if (!/^[a-f0-9]{64}$/i.test(v.corpusDigest) || v.fileCount !== v.files.length) return false;
  if (typeof v.totalBytes !== "number" || !Number.isInteger(v.totalBytes) || v.totalBytes < 0) {
    return false;
  }
  return v.files.every((f) => {
    if (!f || typeof f !== "object") return false;
    const file = f as Record<string, unknown>;
    return (
      typeof file.path === "string" &&
      /^stroke-json\/[0-9a-f]{4,6}\.json$/i.test(file.path) &&
      typeof file.sha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(file.sha256) &&
      typeof file.bytes === "number" &&
      Number.isInteger(file.bytes) &&
      file.bytes >= 0
    );
  });
}
