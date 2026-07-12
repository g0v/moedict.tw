import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Container-specific override: replace `vp exec tsx` webServer command with direct
// `tsx` call since `vp` (vite-plus) bundles darwin-arm64 native binaries that don't
// run inside the Linux aarch64 container image.
export default defineConfig({
  ...base,
  webServer: {
    ...(base.webServer as object),
    command: "node_modules/.bin/tsx tests/e2e/serve.ts",
  },
});
