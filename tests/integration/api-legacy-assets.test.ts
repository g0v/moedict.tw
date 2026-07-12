/**
 * Regression: the Worker must serve the local-edited stroke-animation loader
 * (not proxy through to a stale R2 copy) and that JS must embed the inline
 * SVG spinner instead of the FontAwesome <i class="icon-spinner"> webfont.
 *
 * Background: in production the asset is stored in R2 and last-modified stamps
 * drift from the checked-in source. A regression here (stale R2 upload) is
 * what motivated this suite.
 */

import { describe, expect, it } from "vite-plus/test";
import { fetchFromServer } from "./_harness";

describe("/assets/js/jquery.strokeWords.js", () => {
  it("serves the local-edited loader JS via the ASSETS binding", async () => {
    const res = await fetchFromServer("/assets/js/jquery.strokeWords.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/javascript/);
  });

  it("embeds the inline SVG spinner (moe-stroke-loader-spinner)", async () => {
    const res = await fetchFromServer("/assets/js/jquery.strokeWords.js");
    const body = await res.text();
    expect(body).toMatch(/<svg[^>]*class=\\"moe-stroke-loader-spinner/);
    expect(body).toContain('viewBox=\\"0 0 1568 1792\\"');
  });

  it('never falls back to the webfont <i class="icon-spinner"> markup', async () => {
    const res = await fetchFromServer("/assets/js/jquery.strokeWords.js");
    const body = await res.text();
    expect(body).not.toMatch(/class=\\"icon-spinner/);
    expect(body).not.toMatch(/\bicon-spin\b/);
  });
});
