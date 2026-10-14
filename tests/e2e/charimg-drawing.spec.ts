import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./_fixtures";

// #175: identical segment text must not route input to the last occurrence.
const REPEATED_WORD_PATH = `/${encodeURIComponent("飛飛龍飛")}`;

async function inkFlags(canvases: Locator): Promise<boolean[]> {
  return canvases.evaluateAll((elements) =>
    elements.map((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 3 && value > 0);
    }),
  );
}

async function drawingOrigin(canvas: Locator): Promise<{ x: number; y: number }> {
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + 40, y: box!.y + 40 };
}

async function drawMouse(page: Page, canvas: Locator): Promise<void> {
  const { x, y } = await drawingOrigin(canvas);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 50, y + 50, { steps: 10 });
  await page.mouse.up();
}

for (const input of ["mouse", "touch"] as const) {
  test.describe(`repeated hollow glyphs: ${input}`, () => {
    test.use({
      hasTouch: input === "touch",
      viewport: input === "touch" ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    });

    test("draws each occurrence independently and clears every canvas", async ({ page }) => {
      await page.goto(REPEATED_WORD_PATH);
      const canvases = page.locator(".charimg-draw-canvas");
      // Main word + 飛 / 飛 / 龍 / 飛, with adjacent and non-adjacent repeats.
      await expect(canvases).toHaveCount(5);
      await expect(page.getByLabel("鏤空描寫模式")).toBeChecked();
      expect(await inkFlags(canvases)).toEqual([false, false, false, false, false]);

      const session = input === "touch" ? await page.context().newCDPSession(page) : null;
      try {
        for (let index = 0; index < 5; index++) {
          const canvas = canvases.nth(index);
          if (session) {
            const { x, y } = await drawingOrigin(canvas);
            await session.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [{ x, y, id: 1 }],
            });
            for (let step = 1; step <= 10; step++) {
              await session.send("Input.dispatchTouchEvent", {
                type: "touchMove",
                touchPoints: [{ x: x + step * 5, y: y + step * 5, id: 1 }],
              });
            }
            await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          } else {
            await drawMouse(page, canvas);
          }
          expect(await inkFlags(canvases)).toEqual(
            Array.from({ length: 5 }, (_, position) => position <= index),
          );
        }

        await page.getByRole("button", { name: "清除描寫" }).click();
        expect(await inkFlags(canvases)).toEqual([false, false, false, false, false]);
      } finally {
        await session?.detach();
      }
    });
  });
}
