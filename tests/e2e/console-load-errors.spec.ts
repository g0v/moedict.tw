import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./_fixtures";

interface RouteDictionaryDataOptions {
  forceCns404?: boolean;
  onCnsRequest?: (url: string) => void;
  onDictionaryRequest?: (url: string) => void;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const STYLES_CSS_PATH = path.join(REPO_ROOT, "data", "assets", "styles.css");

const EDUKAI_URL_PATTERN = "**/assets-legacy/fonts/edukai-*.ttf";
const BIAUKAI_URL_PATTERN = "**/BiauKai.ttf*";

// Intercept legacy styles.css the same way legacy-styles-regression.spec.ts does,
// serving the current working-tree data/assets/styles.css so the MOEDICT-IOS-KAI
// @font-face is present and exercises the BiauKai src URL.
//
// Route patterns accept optional query strings (glob `*`) so that versioned
// URLs like `styles.css?v=20260711` are intercepted. Every intercepted URL is
// recorded so the test can assert that each loaded legacy stylesheet URL
// carries a stable non-empty `v` query parameter (cache-busting version).
// Returns a thunk for whether the CSS was requested and an array of the
// intercepted stylesheet URLs.
async function routeStylesCss(page: Page): Promise<{ loaded: () => boolean; urls: string[] }> {
  const css = readFileSync(STYLES_CSS_PATH, "utf-8");
  let loaded = false;
  const urls: string[] = [];
  const handler = (route: Route) => {
    loaded = true;
    urls.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "text/css; charset=utf-8",
      headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      body: css,
    });
  };
  // Tighter than styles.css* — two patterns: exact (no query) and query-only.
  // styles.css* would also match styles.css.bak; styles.css?* matches only
  // the versioned URL. Both are needed so RED (no query) and GREEN (with v)
  // are intercepted without breaking interception.
  await page.route("https://r2-assets.test.local/styles.css", handler);
  await page.route("https://r2-assets.test.local/styles.css?*", handler);
  await page.route("**/assets/styles.css", handler);
  await page.route("**/assets/styles.css?*", handler);
  // When window.Capacitor is set, offline-api.ts intercepts /api/config and
  // returns assetBaseUrl: '/assets-legacy', so AssetLoader loads CSS from
  // /assets-legacy/styles.css — intercept that path too.
  await page.route("**/assets-legacy/styles.css", handler);
  await page.route("**/assets-legacy/styles.css?*", handler);
  return { loaded: () => loaded, urls };
}

// Collect console.error messages, excluding noise from the fixture's intentional
// r2-*.test.local 404 blocker (those 404s are harness artifacts, not the
// EduKai/BiauKai behavior under test). App-origin errors (127.0.0.1, localhost,
// or any non-r2 host) are always retained.
function collectConsoleErrors(page: Page, consoleErrors: string[]): void {
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const loc = msg.location();
    const locUrl = loc.url ?? "";
    if (locUrl) {
      try {
        if (new URL(locUrl).hostname === "r2-assets.test.local") return;
      } catch {
        // Not a parseable URL — keep the message (could be a JS runtime error).
      }
    }
    consoleErrors.push(msg.text());
  });
}

// Block CSS sub-resources that would DNS-fail (same as legacy-styles-regression
// blockCssSubresources) so networkidle can fire.
async function blockCssSubresources(page: Page): Promise<void> {
  const notFound = (route: Route) =>
    route.fulfill({ status: 404, contentType: "text/plain; charset=utf-8", body: "" });
  await page.route("**/assets/fonts/**", notFound);
  await page.route("**/assets/images/leather_x2.jpg", notFound);
  await page.route("**/assets/images/subtle_stripes_x2.png", notFound);
}

// When window.Capacitor is set, offline-api.ts intercepts /api/* and serves
// dictionary data from locally bundled files via originalFetch('/dictionary/...').
// In the test environment these paths don't exist on the server, so route them
// to the data/dictionary/ fixtures so the Capacitor-simulated page renders.
async function routeDictionaryData(
  page: Page,
  options?: RouteDictionaryDataOptions,
): Promise<void> {
  const DATA_DICT = path.join(REPO_ROOT, "data", "dictionary");
  const cnsMode = options?.forceCns404 ? "force404" : "local";

  await page.route("**/dictionary/**", (route: Route) => {
    const reqUrl = route.request().url();
    options?.onDictionaryRequest?.(reqUrl);
    const url = new URL(reqUrl);
    const key = url.pathname.replace(/^\/dictionary\//, "");
    const filePath = path.join(DATA_DICT, key);
    try {
      const body = readFileSync(filePath);
      return route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: Buffer.from(body),
      });
    } catch {
      return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
    }
  });

  await page.route("**/cns/**", (route: Route) => {
    const reqUrl = route.request().url();
    const urlPath = new URL(reqUrl).pathname;
    // If the URL is a /dictionary/cns/... fallback path, let it fall through to
    // the **/dictionary/** handler (registered before this one; Playwright runs
    // handlers in reverse-registration order, so "fallback" passes control to it).
    if (urlPath.startsWith("/dictionary/")) {
      return route.fallback();
    }
    options?.onCnsRequest?.(reqUrl);
    if (cnsMode === "force404") {
      return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
    }
    const url = new URL(reqUrl);
    const key = url.pathname.replace(/^\/cns\//, "");
    const filePath = path.join(DATA_DICT, "cns", key);
    try {
      const body = readFileSync(filePath);
      return route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: Buffer.from(body),
      });
    } catch {
      return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
    }
  });
  // Also route search-index that the offline API fetches
  await page.route("**/search-index/**", (route: Route) => {
    const url = new URL(route.request().url());
    const key = url.pathname.replace(/^\/search-index\//, "");
    const filePath = path.join(DATA_DICT, "search-index", key);
    try {
      const body = readFileSync(filePath);
      return route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: Buffer.from(body),
      });
    } catch {
      return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
    }
  });
}

test.describe("console load errors — EduKai 404 and BiauKai decode", () => {
  test("normal web load: no EduKai fetch, no console.error, no BiauKai decode", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const edukaiRequests: string[] = [];
    const biaukaiRequests: string[] = [];

    collectConsoleErrors(page, consoleErrors);
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await blockCssSubresources(page);
    const { loaded: stylesCssLoaded, urls: stylesUrls } = await routeStylesCss(page);

    // Intercept EduKai requests (record without DNS-fail) — fulfill with 404
    // so the browser logs the error we're testing for, but networkidle fires.
    await page.route(EDUKAI_URL_PATTERN, (route) => {
      edukaiRequests.push(route.request().url());
      return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
    });
    // Intercept BiauKai requests — fulfill as 0-byte font/ttf to reproduce
    // the production R2 behavior (R2 serves a 0-byte body with font/ttf
    // content-type, causing "Failed to decode downloaded font" warnings).
    await page.route(BIAUKAI_URL_PATTERN, (route) => {
      biaukaiRequests.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: "font/ttf",
        body: Buffer.alloc(0),
      });
    });

    // Ensure NO window.Capacitor (normal web)
    await page.addInitScript(() => {
      // @ts-expect-error -- deliberately delete for normal-web simulation
      delete window.Capacitor;
    });

    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);

    // Sanity: the intercepted legacy styles.css must have actually loaded —
    // otherwise the BiauKai no-request assertion is vacuous (the @font-face
    // that triggers the fetch lives in that stylesheet).
    expect(
      stylesCssLoaded(),
      "legacy styles.css must be loaded to exercise BiauKai @font-face",
    ).toBe(true);

    // Deterministically exercise the MOEDICT-IOS-KAI @font-face (whose src
    // is the 0-byte BiauKai URL) via document.fonts.load. The title font
    // stack lists Biaukai (local) before MOEDICT-IOS-KAI, so on macOS the
    // browser may resolve Biaukai locally and never attempt the URL —
    // document.fonts.load forces the browser to evaluate the named face
    // directly, guaranteeing a URL fetch if the @font-face has a url() src.
    // Also append a probe element whose sole family is MOEDICT-IOS-KAI.
    await page.evaluate(async () => {
      const probe = document.createElement("span");
      probe.style.fontFamily = "MOEDICT-IOS-KAI";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.textContent = "字";
      document.body.appendChild(probe);
      // Force the browser to attempt loading the MOEDICT-IOS-KAI face.
      try {
        await document.fonts.load('16px "MOEDICT-IOS-KAI"', "字");
      } catch {
        // load() rejects on decode failure — expected for 0-byte font.
      }
      await document.fonts.ready;
    });

    // --- BiauKai assertion (non-vacuous: document.fonts.load exercised the face) ---
    // RED evidence: in the pre-fix state, biaukaiRequests MUST be non-empty
    // (the @font-face src is a url(), so document.fonts.load triggers a
    // network fetch). If this is empty, the assertion is vacuous — the
    // @font-face was never exercised. After Task 2 changes src to
    // local(BiauKai), no URL request is made and this passes.
    // Use expect.soft so both BiauKai and EduKai failures are reported
    // in a single RED run (both are independent root causes).
    expect
      .soft(biaukaiRequests, "normal web load must NOT request the 0-byte BiauKai URL")
      .toEqual([]);

    // --- EduKai assertions ---
    expect.soft(edukaiRequests, "normal web load must NOT request the EduKai font").toEqual([]);
    expect(consoleErrors, "normal web load must have zero console.error").toEqual([]);
    expect(pageErrors, "normal web load must have zero pageerror").toEqual([]);

    // Computed font-family on .result .entry .title must NOT start with
    // "MOE EduKai Android" — it should fall through to system Kaiti.
    const titleFontFamily = await page.evaluate(() => {
      const el = document.querySelector(".result .entry .title");
      return el ? getComputedStyle(el).fontFamily : null;
    });
    expect(titleFontFamily, "title element must exist on the page").not.toBeNull();
    expect(
      titleFontFamily,
      "title font-family must NOT include MOE EduKai Android on web",
    ).not.toContain("MOE EduKai Android");

    // Every loaded legacy stylesheet URL must carry a stable non-empty `v`
    // query parameter so edge-cached old objects are bustable on deploy.
    expect(
      stylesUrls.length,
      "at least one legacy stylesheet must be loaded",
    ).toBeGreaterThanOrEqual(1);
    for (const url of stylesUrls) {
      const v = new URL(url).searchParams.get("v");
      expect(v, `legacy stylesheet URL must have non-empty v param: ${url}`).toBeTruthy();
    }
  });

  test("Capacitor-simulated load: moe-capacitor class present, EduKai in font stack", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    collectConsoleErrors(page, consoleErrors);

    await blockCssSubresources(page);
    const { loaded: stylesCssLoaded, urls: stylesUrls } = await routeStylesCss(page);
    await routeDictionaryData(page);

    // Simulate Capacitor runtime BEFORE the app's main.tsx runs
    await page.addInitScript(() => {
      // @ts-expect-error -- simulating Capacitor webview runtime
      window.Capacitor = { isNative: true, getPlatform: () => "ios" };
    });

    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);

    // moe-capacitor class must be present on <html>
    const hasCapacitorClass = await page.evaluate(() =>
      document.documentElement.classList.contains("moe-capacitor"),
    );
    // Sanity: the intercepted legacy styles.css must have actually loaded —
    // otherwise the font-family assertions are vacuous (the @font-face and
    // legacy font stacks live in that stylesheet).
    expect(stylesCssLoaded(), "legacy styles.css must be loaded to exercise font stacks").toBe(
      true,
    );
    expect(
      hasCapacitorClass,
      "html must have moe-capacitor class when window.Capacitor is set",
    ).toBe(true);

    // Computed font-family on .result .entry .title MUST include "MOE EduKai Android"
    const titleFontFamily = await page.evaluate(() => {
      const el = document.querySelector(".result .entry .title");
      return el ? getComputedStyle(el).fontFamily : null;
    });
    expect(titleFontFamily, "title element must exist").not.toBeNull();
    expect(
      titleFontFamily,
      "Capacitor load must include MOE EduKai Android in computed font-family",
    ).toContain("MOE EduKai Android");

    // No console errors from the Capacitor load either (the @font-face is
    // present but the font file at /assets-legacy/ is intercepted by the
    // test server; in real Capacitor it would be bundled locally).
    // Note: we don't assert zero console errors here because the test server
    // 404s the font file — the assertion is about the CSS stack, not the
    // actual font fetch in the test environment.

    // Every loaded legacy stylesheet URL must carry a stable non-empty `v`
    // query parameter so edge-cached old objects are bustable on deploy.
    expect(
      stylesUrls.length,
      "at least one legacy stylesheet must be loaded",
    ).toBeGreaterThanOrEqual(1);
    for (const url of stylesUrls) {
      const v = new URL(url).searchParams.get("v");
      expect(v, `legacy stylesheet URL must have non-empty v param: ${url}`).toBeTruthy();
    }
  });
});

test.describe("offline CNS fallback", () => {
  test("Capacitor offline /api/cns: tries /cns/ first, falls back to /dictionary/", async ({
    page,
  }) => {
    const cnsRequests: string[] = [];
    const dictionaryRequests: string[] = [];
    await routeStylesCss(page);
    await blockCssSubresources(page);
    await routeDictionaryData(page, {
      forceCns404: true,
      onCnsRequest: (url) => cnsRequests.push(url),
      onDictionaryRequest: (url) => {
        const pathname = new URL(url).pathname;
        if (pathname.startsWith("/dictionary/cns/")) {
          dictionaryRequests.push(url);
        }
      },
    });

    // Keep this isolated fetch test deterministic: app runtime still loads from
    // offline mode and can be queried directly.
    await page.addInitScript(() => {
      // @ts-expect-error -- simulating Capacitor webview runtime
      window.Capacitor = { isNative: true, getPlatform: () => "ios" };
    });

    await page.goto("/%E8%90%8C");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);

    const apiResult = await page.evaluate(async () => {
      const res = await fetch(`/api/cns/${encodeURIComponent("䴉")}.json`);
      return {
        status: res.status,
        bodyText: await res.text(),
        contentType: res.headers.get("content-type") ?? "",
      };
    });

    // cns paths are probed first in offline API get(), so we should see at least one miss.
    expect(cnsRequests.length).toBeGreaterThanOrEqual(1);
    expect(cnsRequests.some((url) => url.includes("/cns/by-codepoint/4D/4D09.json"))).toBe(
      true,
    );
    // Because forceCns404 is enabled, /dictionary fallback should still resolve.
    expect(dictionaryRequests.length).toBeGreaterThanOrEqual(1);
    expect(
      dictionaryRequests.some((url) => url.includes("/dictionary/cns/by-codepoint/4D/4D09.json")),
    ).toBe(true);

    expect(apiResult.status).toBe(200);
    expect(apiResult.contentType).toContain("application/json");
    const apiJson = JSON.parse(apiResult.bodyText) as { char?: string };
    expect(apiJson.char).toBe("䴉");
  });
});

test.describe("bare home URL — no unused font preload hints", () => {
  test("normal web load at /: zero link[rel=preload][as=font] for optional legacy fonts", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];

    collectConsoleErrors(page, consoleErrors);
    // Capture warning-level messages matching the preload-not-used pattern
    // if they appear; this is secondary evidence, not the primary assertion
    // (the primary contract is zero preload hint elements in the DOM).
    page.on("console", (msg) => {
      if (
        msg.type() === "warning" &&
        /preloaded using link preload but not used/i.test(msg.text())
      ) {
        consoleWarnings.push(msg.text());
      }
    });

    await blockCssSubresources(page);
    await routeStylesCss(page);

    // Ensure NO window.Capacitor (normal web)
    await page.addInitScript(() => {
      // @ts-expect-error -- deliberately delete for normal-web simulation
      delete window.Capacitor;
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);

    // Primary contract: AssetLoader must NOT insert any <link rel="preload"
    // as="font"> elements for optional legacy fonts. The legacy @font-face
    // rules in styles.css already lazy-load on actual glyph/family demand;
    // unconditional preload hints waste downloads and trigger intermittent
    // Chromium warnings ("preloaded using link preload but not used").
    const preloadLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('link[rel="preload"][as="font"]')).map((el) => ({
        href: (el as HTMLLinkElement).href,
        type: (el as HTMLLinkElement).type,
      }));
    });
    expect(preloadLinks, "bare home URL must have zero font preload hint elements").toEqual([]);

    // Secondary: if any preload-not-used warnings appeared, log them for
    // diagnostics — but the primary assertion above is the DOM contract.
    if (consoleWarnings.length > 0) {
      console.log(
        `[preload-warnings] ${consoleWarnings.length} warnings:\n${consoleWarnings.map((w) => "  " + w).join("\n")}`,
      );
    }

    // No console errors from the bare home load.
    expect(consoleErrors, "bare home URL must have zero console.error").toEqual([]);
  });
});
