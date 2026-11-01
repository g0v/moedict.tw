import { expect, test } from "./_fixtures";
import { waitForAppReady } from "./readiness";

test("search input cannot navigate to another origin", async ({ page }) => {
  await page.goto("/%E8%90%8C");
  await waitForAppReady(page);
  const initialUrl = page.url();
  const input = page.locator("#query");

  for (const value of [
    "//outside.example/path",
    "\\\\outside.example/path",
    "'\\\\outside.example/path",
  ]) {
    await input.fill(value);
    await input.press("Enter");
    expect(page.url()).toBe(initialUrl);
  }
});

test("dictionary markup retains formatting without active content", async ({ page }) => {
  await page.route("**/api/%E8%90%8C.json", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "萌",
        heteronyms: [
          {
            bopomofo: "ㄇㄥˊ",
            definitions: [
              {
                def: '<br><sup>1</sup><a href="./#字">字</a><img src=x onerror="window.__dictionaryExecuted=true">',
                example: ['<span onclick="window.__dictionaryExecuted=true">例子</span>'],
              },
            ],
          },
        ],
      }),
    });
  });
  await page.goto("/%E8%90%8C");
  await waitForAppReady(page);
  const definition = page.locator(".result .definition .def").first();
  await expect(definition).toContainText("字");
  await expect(definition.locator("sup")).toHaveText("1");
  await expect(definition.locator('a[href="./#字"]')).toHaveText("字");
  expect(await page.locator(".result img").count()).toBe(0);
  expect(
    await page.evaluate(
      () => (window as Window & { __dictionaryExecuted?: boolean }).__dictionaryExecuted,
    ),
  ).toBeUndefined();
  expect(await page.locator(".result [onclick], .result [onerror]").count()).toBe(0);
});
