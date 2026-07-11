/**
 * Standalone server launcher used by Playwright's webServer.
 *
 * Starts a Miniflare instance with:
 *   - The bundled worker (built on demand from worker/index.ts)
 *   - Seeded R2 buckets (DICTIONARY, ASSETS, FONTS) from tests/helpers/fixtures.ts
 *   - Static assets served from dist/client/ (SPA fallback for non-matched paths)
 *
 * Run: `vp exec tsx tests/e2e/serve.ts` (invoked automatically by Playwright).
 */
import { startTestServer } from "../helpers/miniflare-server";

const PORT = Number(process.env.E2E_PORT ?? 8877);

async function main(): Promise<void> {
  const server = await startTestServer({ includeAssets: true, port: PORT });
  console.log(`[e2e-server] ready at ${server.url.toString()}`);

  let stopped = false;
  const shutdown = async (signal: string) => {
    if (stopped) return;
    stopped = true;
    console.log(`[e2e-server] received ${signal}, shutting down`);
    try {
      await server.stop();
    } catch (err) {
      console.error("[e2e-server] stop error", err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
}

main().catch((err) => {
  console.error("[e2e-server] startup failed", err);
  process.exit(1);
});
