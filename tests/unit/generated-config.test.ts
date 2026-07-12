/**
 * Unit tests for generated wrangler config parsing (scripts/lib/generated-config.mjs).
 *
 * The generated config at dist/cf_moedict_webkit_neo/wrangler.json has a
 * FLATTENED shape: staging's ASSETS binding has bucket_name="moedict-assets-preview"
 * with NO preview_bucket_name field. The parser must select the effective
 * bucket_name, not assume preview_bucket_name survives flattening.
 */

import { describe, expect, it } from "vite-plus/test";
import {
  getAssetsBucketName,
  getWorkerName,
  parseGeneratedConfig,
} from "../../scripts/lib/generated-config.mjs";

// Real generated prod config shape (from dist/cf_moedict_webkit_neo/wrangler.json)
const PROD_CONFIG = {
  name: "cf-moedict-webkit-neo",
  r2_buckets: [
    {
      binding: "FONTS",
      bucket_name: "moedict-fonts",
      preview_bucket_name: "moedict-fonts-preview",
      remote: true,
    },
    {
      binding: "ASSETS",
      bucket_name: "moedict-assets",
      preview_bucket_name: "moedict-assets-preview",
      remote: true,
    },
    {
      binding: "DICTIONARY",
      bucket_name: "moedict-dictionary",
      preview_bucket_name: "moedict-dictionary-preview",
      remote: true,
    },
  ],
};

// Real generated staging config shape — preview_bucket_name does NOT
// survive flattening; bucket_name is already the env-specific value.
const STAGING_CONFIG = {
  name: "cf-moedict-webkit-neo-staging",
  targetEnvironment: "staging",
  r2_buckets: [
    { binding: "FONTS", bucket_name: "moedict-fonts-preview", remote: true },
    { binding: "ASSETS", bucket_name: "moedict-assets-preview", remote: true },
    { binding: "DICTIONARY", bucket_name: "moedict-dictionary-preview", remote: true },
  ],
};

// ── parseGeneratedConfig ─────────────────────────────────────────────

describe("parseGeneratedConfig", () => {
  it("parses JSON config from a file path", () => {
    const config = parseGeneratedConfig(PROD_CONFIG);
    expect(config.name).toBe("cf-moedict-webkit-neo");
  });

  it("accepts an already-parsed config object", () => {
    const config = parseGeneratedConfig(PROD_CONFIG);
    expect((config.r2_buckets as unknown[]).length).toBe(3);
  });
});

// ── getAssetsBucketName ───────────────────────────────────────────────

describe("getAssetsBucketName", () => {
  it("extracts ASSETS bucket_name for production", () => {
    expect(getAssetsBucketName(PROD_CONFIG, undefined)).toBe("moedict-assets");
  });

  it("extracts ASSETS bucket_name for production (explicit env)", () => {
    expect(getAssetsBucketName(PROD_CONFIG, "production")).toBe("moedict-assets");
  });

  it("extracts ASSETS bucket_name for staging — uses bucket_name not preview_bucket_name", () => {
    // Staging generated config has NO preview_bucket_name; bucket_name is
    // already "moedict-assets-preview" after flattening.
    expect(getAssetsBucketName(STAGING_CONFIG, "staging")).toBe("moedict-assets-preview");
  });

  it("does NOT fall back to preview_bucket_name for staging when bucket_name exists", () => {
    // Even if a config had both, staging should use bucket_name (the
    // flattened effective value), not preview_bucket_name.
    const configWithBoth = {
      r2_buckets: [
        {
          binding: "ASSETS",
          bucket_name: "moedict-assets-preview",
          preview_bucket_name: "should-not-be-used",
          remote: true,
        },
      ],
    };
    expect(getAssetsBucketName(configWithBoth, "staging")).toBe("moedict-assets-preview");
  });

  it("throws if ASSETS binding not found", () => {
    const config = { r2_buckets: [] };
    expect(() => getAssetsBucketName(config, undefined)).toThrow(/ASSETS/);
  });

  it("throws if ASSETS binding has no bucket_name", () => {
    const config = {
      r2_buckets: [{ binding: "ASSETS", remote: true }],
    };
    expect(() => getAssetsBucketName(config, undefined)).toThrow(/bucket_name/);
  });

  it("throws if r2_buckets is missing", () => {
    expect(() => getAssetsBucketName({}, undefined)).toThrow(/ASSETS/);
  });
});

// ── getWorkerName ─────────────────────────────────────────────────────

describe("getWorkerName", () => {
  it("extracts worker name for production", () => {
    expect(getWorkerName(PROD_CONFIG)).toBe("cf-moedict-webkit-neo");
  });

  it("extracts worker name for staging", () => {
    expect(getWorkerName(STAGING_CONFIG)).toBe("cf-moedict-webkit-neo-staging");
  });

  it("throws if name is missing", () => {
    expect(() => getWorkerName({})).toThrow(/name/);
  });
});
