import { describe, expect, it } from "vite-plus/test";
import { LEGACY_STYLESHEET_VERSION, legacyStylesheetUrl } from "../../src/utils/media-cdn";

describe("legacyStylesheetUrl", () => {
  it("keeps the Worker-proxied /assets path for the website", () => {
    expect(legacyStylesheetUrl(undefined, false)).toBe(
      `/assets/styles.css?v=${LEGACY_STYLESHEET_VERSION}`,
    );
    expect(legacyStylesheetUrl("", false)).toBe(
      `/assets/styles.css?v=${LEGACY_STYLESHEET_VERSION}`,
    );
  });

  it("does not request /assets/styles.css from the offline bundle", () => {
    expect(legacyStylesheetUrl(undefined, true)).toBe(
      `/assets-legacy/styles.css?v=${LEGACY_STYLESHEET_VERSION}`,
    );
    expect(legacyStylesheetUrl("/assets-legacy", true)).toBe(
      `/assets-legacy/styles.css?v=${LEGACY_STYLESHEET_VERSION}`,
    );
    expect(legacyStylesheetUrl("https://r2-assets.moedict.tw", false)).toBe(
      `https://r2-assets.moedict.tw/styles.css?v=${LEGACY_STYLESHEET_VERSION}`,
    );
  });
});
