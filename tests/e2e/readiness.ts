import type { Page } from "@playwright/test";

export type ReadinessKind =
  | "shell"
  | "dictionary"
  | "dictionary-lang"
  | "starred"
  | "preferences"
  | "stroke"
  | "static"
  | "visual"
  | "about"
  | "radical";

/** Wait for an observable application contract; never waits on global network idleness. */
export async function waitForAppReady(page: Page, kind: ReadinessKind = "shell"): Promise<void> {
  if (kind === "visual") {
    await waitForAppReady(page, "shell");
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images)
          .filter((image) => !image.complete)
          .map(
            (image) =>
              new Promise<void>((resolve) => {
                image.addEventListener("load", () => resolve(), { once: true });
                image.addEventListener("error", () => resolve(), { once: true });
              }),
          ),
      );
    });
    return;
  }

  if (kind === "starred") {
    await page.getByRole("heading", { name: /字詞紀錄簿/ }).waitFor({ state: "visible" });
    return;
  }

  if (kind === "preferences") {
    await page.locator("#nav-fulltext-search, #user-pref").first().waitFor({ state: "attached" });
    return;
  }

  if (kind === "stroke") {
    await page
      .locator(".entry-actions, a.iconic-circle.stroke")
      .first()
      .waitFor({ state: "attached" });
    return;
  }

  if (kind === "static") {
    await page.locator("body").waitFor({ state: "visible" });
    return;
  }

  if (kind === "about") {
    // About.tsx sets document.body.className = "about web" in a useEffect
    // that commits alongside the .about-page root -- both land in the same
    // React commit, but only waiting on "body: visible" (the "shell"
    // default) can observe the DOM before that effect has actually run,
    // racing legacy-styles-regression's before/after navigation pair.
    // Wait for the body class directly so both snapshots are taken from an
    // identically-settled DOM.
    await page.locator(".about-page").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => document.body.className === "about web");

    // /about loads the legacy stylesheet TWICE, from two different origins:
    // AssetLoader.tsx (wraps every page via Layout.tsx) fetches it from
    // /api/config's assetBaseUrl (the R2-proxy host in production), while
    // About.tsx's OWN loadExternalStyles() unconditionally injects a second
    // <link href="/assets/styles.css?..."> (same-origin, Worker-proxied).
    // Both stylesheets define the same rules (e.g. `body { background-image:
    // url(images/subtle_stripes_x2.png) }`), but each resolves its own
    // relative url() against its OWN href -- so whichever <link> finishes
    // loading LAST wins the cascade, and its resolved absolute image URL
    // becomes the body's effective background-image. Snapshotting before
    // both requests have settled races that outcome (confirmed: legacy-
    // styles-regression's before/after digest occasionally disagreed only
    // on body's background-image host). Wait for both <link> elements'
    // stylesheets to actually load before returning, so both snapshots
    // observe the same (stable) cascade winner.
    // Both AssetLoader.tsx's link (data-asset-id="styles-css") AND
    // About.tsx's own link (data-r2-styles) are independently injected --
    // require BOTH to be present AND loaded, not just whichever has landed
    // by the time this check first runs (an "every()" over a
    // not-yet-complete NodeList would vacuously pass on the first-arriving
    // link alone and still race the second one's insertion).
    await page.waitForFunction(() => {
      const assetLoaderLink = document.querySelector<HTMLLinkElement>(
        'link[data-asset-id="styles-css"]',
      );
      const aboutOwnLink = document.querySelector<HTMLLinkElement>("link[data-r2-styles]");
      return assetLoaderLink?.sheet != null && aboutOwnLink?.sheet != null;
    });
    return;
  }

  if (kind === "radical") {
    // RadicalView/RadicalDetailView render `.result` synchronously (even in
    // the "載入中…" loading state) and only populate `a.stroke-char` once
    // their async fetchRadicalRows() fetch resolves -- waiting on `.result`
    // alone (the "dictionary" kind's selector) resolves before that fetch
    // settles, racing before/after snapshot pairs that depend on the full
    // rendered content (e.g. legacy-styles-regression's computed-style
    // digest).
    await page.locator("a.stroke-char").first().waitFor({ state: "visible", timeout: 15_000 });
    return;
  }

  if (kind === "dictionary") {
    await page
      .locator('h1.title, .dictionary-error, [role="alert"], .result')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    return;
  }

  if (kind === "dictionary-lang") {
    // DictionaryPage sets document.body.classList.add(`lang-${lang}`) in a
    // useEffect that commits alongside .result (same render), but only
    // waiting on "dictionary" (.result visible) can observe the DOM one
    // tick before that effect has actually run -- races
    // legacy-styles-regression's before/after navigation pair, whose
    // computed-style digest includes body.className verbatim (and every
    // `body.lang-X ...` cascade rule keyed off it). Wait for the lang class
    // itself, not just a visible container, so both snapshots are taken
    // from an identically-settled DOM.
    await page
      .locator('h1.title, .dictionary-error, [role="alert"], .result')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForFunction(() => /\blang-[a-z]+\b/.test(document.body.className));
    return;
  }

  await page.locator("#app, #root, body").first().waitFor({ state: "visible" });
}
