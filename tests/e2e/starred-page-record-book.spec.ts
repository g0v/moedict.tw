import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

// RESCOPE #88 (cross-language a/t/h/c record-book overview) and #219
// (bounded manual UTF-8 plain-text export/import of favorites) on top of
// src/pages/StarredPage.tsx. Seeds localStorage directly (matching the
// existing "starred page" describe block in interactions.spec.ts) rather
// than clicking star buttons across four dictionary pages, since the star
// storage format itself is already covered by interactions.spec.ts and
// tests/unit/word-record-utils.test.ts.

test.describe("#88 cross-language record-book overview", () => {
  test("shows fixed-order grouped headings for languages with starred words, omitting empty groups, with language-correct hrefs", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForAppReady(page, "shell");
    await page.evaluate(() => {
      window.localStorage.setItem("starred-t", '"食"\\n');
      window.localStorage.setItem("starred-c", '"东西"\\n');
    });
    await page.goto("/=*");
    await waitForAppReady(page, "starred");

    await page.getByRole("button", { name: "顯示全部語言" }).click();

    const content = page.locator("#all-langs-content");
    await expect(content).toBeVisible();
    const headings = await content.locator(".lang-group-heading").allTextContents();
    // a and h omitted (no starred words); fixed a/t/h/c order → t before c.
    expect(headings).toEqual(["臺灣台語", "兩岸詞典"]);

    await expect(content.getByRole("link", { name: "食" })).toHaveAttribute("href", "/'%E9%A3%9F");
    await expect(content.getByRole("link", { name: "东西" })).toHaveAttribute(
      "href",
      "/~%E4%B8%9C%E8%A5%BF",
    );
  });

  test("aggregate refreshes after a mutation in the current-language starred section", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForAppReady(page, "shell");
    await page.evaluate(() => {
      window.localStorage.setItem("starred-a", '"萌"\\n');
      window.localStorage.setItem("starred-t", '"食"\\n');
    });
    await page.goto("/=*");
    await waitForAppReady(page, "starred");

    await page.getByRole("button", { name: "顯示全部語言" }).click();
    const content = page.locator("#all-langs-content");
    await expect(content.getByRole("link", { name: "萌" })).toBeVisible();

    // Removing 萌 from the current-language (a) starred section must also
    // drop it from the a-group in the already-open aggregate view. Scope to
    // .starred-section since the aggregate view renders its own row for the
    // same word with the same accessible name (strict-mode ambiguity).
    await page.locator(".starred-section").getByRole("button", { name: "移除收藏「萌」" }).click();
    await expect(content.getByRole("link", { name: "萌" })).toHaveCount(0);
    await expect(content.getByRole("link", { name: "食" })).toBeVisible();
  });
});

test.describe("#219 export/import of favorites", () => {
  test("下載文字檔 downloads a UTF-8 plain-text file, one word per line, current order, deterministic per-language filename", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForAppReady(page, "shell");
    await page.evaluate(() => {
      window.localStorage.setItem("starred-a", '"萌"\\n"典"\\n');
    });
    await page.goto("/=*");
    await waitForAppReady(page, "starred");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下載文字檔" }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe("moedict-starred-a.txt");
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf-8");
    expect(text).toBe("萌\n典");
  });

  test("複製到剪貼簿 succeeds when clipboard-write is granted", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-write", "clipboard-read"]);
    await page.goto("/");
    await waitForAppReady(page, "shell");
    await page.evaluate(() => {
      window.localStorage.setItem("starred-a", '"萌"\\n');
    });
    await page.goto("/=*");
    await waitForAppReady(page, "starred");

    await page.getByRole("button", { name: "複製到剪貼簿" }).click();
    await expect(page.getByRole("status")).toContainText("已複製收藏字詞清單");

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe("萌");
  });

  test("複製到剪貼簿 shows the fallback message when the Clipboard API write is unavailable", async ({
    page,
  }) => {
    // Force writeTextToClipboard's fallback branch to fail deterministically:
    // navigator.clipboard.writeText rejects, then it falls through to
    // document.execCommand("copy") — stub that to also fail, otherwise
    // headless Chromium's execCommand("copy") can silently succeed and mask
    // this test's intent (verifying the "複製失敗" UI status, not the exact
    // API path). Installed via addInitScript so it's set before any page
    // script runs, on both navigations.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("denied")) },
      });
      document.execCommand = () => false;
    });
    await page.goto("/");
    await waitForAppReady(page, "shell");
    await page.evaluate(() => {
      window.localStorage.setItem("starred-a", '"萌"\\n');
    });
    await page.goto("/=*");
    await waitForAppReady(page, "starred");

    await page.getByRole("button", { name: "複製到剪貼簿" }).click();
    await expect(page.getByRole("status")).toContainText("複製失敗");
  });

  test("匯入 textarea is a visible, labeled paste target — imports in pasted order, dedupes, validates, and reports counts", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForAppReady(page, "shell");
    await page.evaluate(() => {
      window.localStorage.setItem("starred-a", '"已收藏"\\n');
      window.localStorage.setItem("starred-t", '"既有"\\n');
    });
    await page.goto("/=*");
    await waitForAppReady(page, "starred");

    await page.getByRole("button", { name: "匯入" }).click();
    const textarea = page.locator("#import-starred-textarea");
    await expect(textarea).toBeVisible();
    await expect(page.locator('label[for="import-starred-textarea"]')).toBeVisible();

    await textarea.fill("萌\n典\n已收藏\n萌\n#");
    await page.getByRole("button", { name: "確認匯入" }).click();

    // Pasted-order merge ahead of the untouched pre-existing word.
    const links = await page.locator(".starred-section .word-list a").allTextContents();
    expect(links).toEqual(["萌", "典", "已收藏"]);

    await expect(page.getByRole("status")).toContainText("已匯入 2 筆，略過 3 筆重複或無效字詞。");

    const raw = await page.evaluate(() => window.localStorage.getItem("starred-a"));
    expect(raw).toBe('"萌"\\n"典"\\n"已收藏"\\n');

    // Sibling-language storage untouched by a current-language-only import.
    const siblingRaw = await page.evaluate(() => window.localStorage.getItem("starred-t"));
    expect(siblingRaw).toBe('"既有"\\n');
  });

  test("empty/whitespace-only paste does not write and keeps the confirm button disabled", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForAppReady(page, "shell");
    await page.goto("/=*");
    await waitForAppReady(page, "starred");

    await page.getByRole("button", { name: "匯入" }).click();
    const textarea = page.locator("#import-starred-textarea");
    await textarea.fill("   \n  ");

    await expect(page.getByRole("button", { name: "確認匯入" })).toBeDisabled();
    const raw = await page.evaluate(() => window.localStorage.getItem("starred-a"));
    expect(raw === "" || raw === null).toBe(true);
  });
});
