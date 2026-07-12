/// <reference types="node" />
/**
 * Unit tests for version-override smoke probe + continuous probe
 * (scripts/lib/smoke-probe.mjs).
 *
 * fetch/sleep are injected — no real network or timers. `continuousProbe`'s
 * elapsed-time bookkeeping is driven entirely by the injected `sleep` call
 * count (never a real clock), so the 120s-boundary test runs in
 * milliseconds.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  continuousProbe,
  finalSmoke,
  probeOnce,
  smokeWithVersionOverride,
} from "../../scripts/lib/smoke-probe.mjs";

const BASE_URL = "https://cf-moedict-webkit-neo-staging.audreyt.workers.dev";
const WORKER_NAME = "cf-moedict-webkit-neo-staging";
const UUID = "11111111-1111-4111-8111-111111111111";
const RELEASE_TAG = "abc1234-def012345678";
const ROUTES = [
  "/",
  "/api/config",
  "/api/%E8%90%8C.json",
  "/assets/index-AbCdEf12.js",
  "/assets/style-12345678.css",
];

function okResponse(headers: Record<string, string> = {}) {
  return new Response("ok", {
    status: 200,
    headers: { "X-Moedict-Release": RELEASE_TAG, ...headers },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

// ── probeOnce ────────────────────────────────────────────────────────

describe("probeOnce", () => {
  it("builds a safe URL (via URL, not string concat) with a unique cache-busting query param", async () => {
    const { fetchImpl, calls } = mockFetch(() => okResponse());
    await probeOnce(BASE_URL, "/api/config", { fetch: fetchImpl });
    await probeOnce(BASE_URL, "/api/config", { fetch: fetchImpl });
    const [first, second] = calls;
    expect(first.url.startsWith(`${BASE_URL}/api/config?`)).toBe(true);
    const firstQuery = new URL(first.url).searchParams.get("_probe");
    const secondQuery = new URL(second.url).searchParams.get("_probe");
    expect(firstQuery).toBeTruthy();
    expect(firstQuery).not.toBe(secondQuery);
  });

  it("preserves percent-encoded route segments exactly", async () => {
    const { fetchImpl, calls } = mockFetch(() => okResponse());
    await probeOnce(BASE_URL, "/api/%E8%90%8C.json", { fetch: fetchImpl });
    expect(new URL(calls[0].url).pathname).toBe("/api/%E8%90%8C.json");
  });
});

// ── smokeWithVersionOverride ─────────────────────────────────────────

describe("smokeWithVersionOverride", () => {
  it('sends Cloudflare-Workers-Version-Overrides: <workerName>="<uuid>" on every route', async () => {
    const seenHeaders: Array<string | null> = [];
    const { fetchImpl } = mockFetch((_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenHeaders.push(headers?.["Cloudflare-Workers-Version-Overrides"] ?? null);
      return okResponse();
    });
    const result = await smokeWithVersionOverride(
      BASE_URL,
      WORKER_NAME,
      UUID,
      ROUTES,
      RELEASE_TAG,
      {
        fetch: fetchImpl,
      },
    );
    expect(result.ok).toBe(true);
    expect(seenHeaders).toHaveLength(ROUTES.length);
    for (const h of seenHeaders) {
      expect(h).toBe(`${WORKER_NAME}="${UUID}"`);
    }
  });

  it("requires HTTP 200 on every route — aborts naming the failing route", async () => {
    let call = 0;
    const { fetchImpl } = mockFetch(() => {
      call += 1;
      return call === 2 ? new Response("err", { status: 500 }) : okResponse();
    });
    await expect(
      smokeWithVersionOverride(BASE_URL, WORKER_NAME, UUID, ROUTES, RELEASE_TAG, {
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(new RegExp(ROUTES[1].replace(/[/]/g, "\\/")));
  });

  it("requires an exact X-Moedict-Release header match — missing header fails", async () => {
    const { fetchImpl } = mockFetch(() => new Response("ok", { status: 200 }));
    await expect(
      smokeWithVersionOverride(BASE_URL, WORKER_NAME, UUID, ["/"], RELEASE_TAG, {
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/X-Moedict-Release/);
  });

  it("requires an exact X-Moedict-Release header match — wrong value fails", async () => {
    const { fetchImpl } = mockFetch(() =>
      okResponse({ "X-Moedict-Release": "some-other-release" }),
    );
    await expect(
      smokeWithVersionOverride(BASE_URL, WORKER_NAME, UUID, ["/"], RELEASE_TAG, {
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/X-Moedict-Release/);
  });

  it("probes every route in order and only that many times", async () => {
    const { fetchImpl, calls } = mockFetch(() => okResponse());
    await smokeWithVersionOverride(BASE_URL, WORKER_NAME, UUID, ROUTES, RELEASE_TAG, {
      fetch: fetchImpl,
    });
    expect(calls).toHaveLength(ROUTES.length);
    for (const [i, route] of ROUTES.entries()) {
      expect(new URL(calls[i].url).pathname).toBe(route.split("?")[0]);
    }
  });
});

// ── finalSmoke ───────────────────────────────────────────────────────

describe("finalSmoke", () => {
  it("probes without any version override header but still requires the release header", async () => {
    const seenHeaders: Array<string | undefined> = [];
    const { fetchImpl } = mockFetch((_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seenHeaders.push(headers?.["Cloudflare-Workers-Version-Overrides"]);
      return okResponse();
    });
    const result = await finalSmoke(BASE_URL, ROUTES, RELEASE_TAG, { fetch: fetchImpl });
    expect(result.ok).toBe(true);
    expect(seenHeaders.every((h) => h === undefined)).toBe(true);
  });

  it("fails when the release header does not match", async () => {
    const { fetchImpl } = mockFetch(() => okResponse({ "X-Moedict-Release": "stale" }));
    await expect(finalSmoke(BASE_URL, ["/"], RELEASE_TAG, { fetch: fetchImpl })).rejects.toThrow(
      /X-Moedict-Release/,
    );
  });
});

// ── continuousProbe ──────────────────────────────────────────────────

describe("continuousProbe", () => {
  it("probes every route each cycle, every 5s (default), via injected sleep", async () => {
    const { fetchImpl, calls } = mockFetch(() => okResponse());
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const result = await continuousProbe(BASE_URL, ROUTES, RELEASE_TAG, {
      fetch: fetchImpl,
      sleep,
      durationMs: 10000,
    });
    expect(result.ok).toBe(true);
    expect(sleepCalls.every((ms) => ms === 5000)).toBe(true);
    expect(calls.length % ROUTES.length).toBe(0);
  });

  it("returns success only once elapsed (sleep-count-driven) time reaches the configured duration — 120s boundary", async () => {
    const { fetchImpl } = mockFetch(() => okResponse());
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };
    const result = await continuousProbe(BASE_URL, ["/"], RELEASE_TAG, {
      fetch: fetchImpl,
      sleep,
      intervalMs: 5000,
      durationMs: 120000,
    });
    expect(result.elapsedMs).toBe(120000);
    expect(result.cycles).toBe(25); // t=0,5,...,120s inclusive
    expect(sleepCalls).toHaveLength(24);
  });

  it("aborts on the first non-200 response without waiting for later routes/cycles", async () => {
    let call = 0;
    const { fetchImpl } = mockFetch(() => {
      call += 1;
      return call === 3 ? new Response("err", { status: 503 }) : okResponse();
    });
    const sleep = async () => {};
    await expect(
      continuousProbe(BASE_URL, ROUTES, RELEASE_TAG, {
        fetch: fetchImpl,
        sleep,
        durationMs: 120000,
      }),
    ).rejects.toThrow(/continuousProbe failed/);
  });

  it("aborts on the first release-header mismatch", async () => {
    let call = 0;
    const { fetchImpl } = mockFetch(() => {
      call += 1;
      return call === 2 ? okResponse({ "X-Moedict-Release": "stale-release" }) : okResponse();
    });
    const sleep = async () => {};
    await expect(
      continuousProbe(BASE_URL, ROUTES, RELEASE_TAG, {
        fetch: fetchImpl,
        sleep,
        durationMs: 120000,
      }),
    ).rejects.toThrow(/X-Moedict-Release/);
  });

  it("propagates a thrown fetch error immediately (network failure)", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNRESET");
    };
    const sleep = async () => {};
    await expect(
      continuousProbe(BASE_URL, ["/"], RELEASE_TAG, {
        fetch: fetchImpl,
        sleep,
        durationMs: 120000,
      }),
    ).rejects.toThrow(/ECONNRESET/);
  });

  it("never uses real wall-clock time — a fake sleep that resolves instantly still completes deterministically", async () => {
    const { fetchImpl } = mockFetch(() => okResponse());
    const start = Date.now();
    await continuousProbe(BASE_URL, ["/"], RELEASE_TAG, {
      fetch: fetchImpl,
      sleep: async () => {},
      intervalMs: 5000,
      durationMs: 120000,
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
