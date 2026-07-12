/**
 * Shared R2 key derivation for the zero-downtime release system.
 *
 * This is the SINGLE source of truth for R2 key construction, imported by
 * both the Worker (production runtime) and Bun deployment scripts (Task 2+).
 * No duplicate string concatenation anywhere — all key derivation goes
 * through these pure functions.
 *
 * Safety guarantees:
 * - Normalize one optional leading slash (`/assets/foo.js` → `assets/foo.js`).
 * - Reject empty paths, `..` traversal (literal or `%2e%2e` encoded),
 *   backslash segments, and empty segments.
 * - `immutableKey` rejects paths not starting with `assets/`.
 * - `isImmutableAsset` only returns true for content-hashed filenames
 *   (Vite's `[name]-[hash].[ext]` convention with exactly 8-char base64url hash).
 * - `validateReleaseTag` rejects tags containing `/`, `\`, `..`, or
 *   percent-encoded traversal — the tag must be one safe path segment.
 */

/**
 * Validate a release tag: must be a single safe path segment.
 * Rejects slashes, backslashes, dot traversal, and percent-encoded traversal.
 * @throws if the tag is empty or contains unsafe characters.
 */
export function validateReleaseTag(tag: string): void {
  if (!tag) {
    throw new Error("Release tag must not be empty");
  }
  if (tag.includes("/") || tag.includes("\\")) {
    throw new Error(`Release tag contains path separator: ${tag}`);
  }
  if (tag === ".." || tag.startsWith(".")) {
    throw new Error(`Release tag contains dot prefix: ${tag}`);
  }
  // Reject percent-encoded traversal (%2e%2e, %2f, %5c).
  const lower = tag.toLowerCase();
  if (lower.includes("%2e%2e") || lower.includes("%2f") || lower.includes("%5c")) {
    throw new Error(`Release tag contains encoded traversal: ${tag}`);
  }
}

/**
 * Validate and normalize a relative path for R2 key construction.
 * Strips one leading slash, then rejects unsafe patterns.
 * Returns the normalized path (no leading slash).
 */
function normalizeRelativePath(path: string): string {
  if (!path) {
    throw new Error("Path must not be empty");
  }

  // Strip exactly one leading slash.
  const normalized = path.startsWith("/") ? path.slice(1) : path;

  if (!normalized) {
    throw new Error("Path must not be empty after stripping leading slash");
  }

  // Reject backslash segments (Windows-style path injection).
  if (normalized.includes("\\")) {
    throw new Error(`Path contains backslash: ${path}`);
  }

  // Reject encoded path traversal (%2e%2e or %2E%2E, %2f, %5c).
  const lower = normalized.toLowerCase();
  if (lower.includes("%2e%2e") || lower.includes("%2f") || lower.includes("%5c")) {
    throw new Error(`Path contains encoded traversal: ${path}`);
  }

  // Reject literal path traversal segments.
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === "") {
      throw new Error(`Path contains empty segment (double slash): ${path}`);
    }
    if (seg === "..") {
      throw new Error(`Path contains traversal segment: ${path}`);
    }
  }

  return normalized;
}

/**
 * R2 key for a file under a specific release.
 * @param tag - Release ID (non-empty, single safe segment)
 * @param relativePath - File path relative to dist/client/ (optional leading slash)
 * @returns `releases/<tag>/<relative-path>`
 */
export function releaseKey(tag: string, relativePath: string): string {
  validateReleaseTag(tag);
  const normalized = normalizeRelativePath(relativePath);
  return `releases/${tag}/${normalized}`;
}

/**
 * R2 key for a content-hashed asset in the global immutable store.
 * @param requestPath - Request path (e.g. `/assets/index-XYZ.js`)
 * @returns `immutable/assets/<relative-path>` — never `immutable/assets/assets/...`
 */
export function immutableKey(requestPath: string): string {
  const normalized = normalizeRelativePath(requestPath);

  // Must start with assets/.
  if (!normalized.startsWith("assets/")) {
    throw new Error(`immutableKey requires path under assets/: ${requestPath}`);
  }

  return `immutable/${normalized}`;
}

/**
 * Vite content-hash pattern: `[name]-[hash].[ext]` where hash is exactly 8
 * base64url chars (`[A-Za-z0-9_-]`). This matches Vite/Rollup's default
 * 8-character hash length. Using exactly 8 (not `{8,}`) prevents
 * false-positives like `g0v-icon-invert.png` where `icon-invert` spans
 * a name-hyphen and would match a variable-length pattern.
 * Safe false-negative is preferable to false-positive (pinning a mutable
 * file as immutable for a year).
 */
const HASH_PATTERN = /^.+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

/**
 * Check if a relative path is a content-hashed asset under `assets/`.
 *
 * Only files matching Vite's `[name]-[hash].[ext]` convention (exactly 8-char
 * base64url hash) are promoted to the global immutable store. Non-hashed
 * files (fonts, images, `.vite/deps`, numeric chunks without hash) remain
 * release-scoped.
 *
 * @param relativePath - File path (with or without leading slash)
 * @returns true if the path is under `assets/` AND the basename has a
 *   content-hash segment, false otherwise. Does not throw.
 */
export function isImmutableAsset(relativePath: string): boolean {
  if (!relativePath) return false;
  const normalized = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  if (!normalized.startsWith("assets/")) return false;
  // Reject .vite/deps — these are dependency pre-bundles, not content-hashed
  // assets eligible for the global immutable store.
  if (normalized.includes(".vite/deps")) return false;
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return HASH_PATTERN.test(basename);
}
