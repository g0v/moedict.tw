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

/** Fetch mock that hangs until its AbortSignal fires (or is already aborted). */
function hangingFetch() {
  return (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      return Promise.reject(new Error("The operation was aborted"));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    });
  };
}

/** Deterministic fake timer: fires the callback synchronously (simulates the timeout having already elapsed, no real wait). */
function instantTimer() {
  const cleared: unknown[] = [];
  const setTimeoutFn = ((cb: () => void) => {
    cb();
    return 1;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: unknown) => {
    cleared.push(id);
  }) as typeof clearTimeout;
  return { setTimeoutFn, clearTimeoutFn, cleared };
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

  it("rejects a non-positive-integer timeoutMs", async () => {
    const { fetchImpl } = mockFetch(() => okResponse());
    await expect(probeOnce(BASE_URL, "/", { fetch: fetchImpl, timeoutMs: 0 })).rejects.toThrow(
      /timeoutMs must be a positive integer/,
    );
    await expect(probeOnce(BASE_URL, "/", { fetch: fetchImpl, timeoutMs: -5 })).rejects.toThrow(
      /timeoutMs must be a positive integer/,
    );
  });

  it("falls back to the real global fetch when no fetch is injected — proven hermetically via a pre-aborted signal (no real network I/O)", async () => {
    const timer = instantTimer();
    await expect(
      probeOnce(BASE_URL, "/", {
        setTimeoutFn: timer.setTimeoutFn,
        clearTimeoutFn: timer.clearTimeoutFn,
      }),
    ).rejects.toThrow(/Probe timed out for route \//);
  });
});

describe("probeOnce timeout", () => {
  it("aborts and throws naming the route when the request hangs past the default 10s timeout", async () => {
    const timer = instantTimer();
    await expect(
      probeOnce(BASE_URL, "/api/config", {
        fetch: hangingFetch(),
        setTimeoutFn: timer.setTimeoutFn,
        clearTimeoutFn: timer.clearTimeoutFn,
      }),
    ).rejects.toThrow(/Probe timed out for route \/api\/config after 10000ms/);
  });

  it("honors a custom timeoutMs in the error message", async () => {
    const timer = instantTimer();
    await expect(
      probeOnce(BASE_URL, "/", {
        fetch: hangingFetch(),
        timeoutMs: 3000,
        setTimeoutFn: timer.setTimeoutFn,
        clearTimeoutFn: timer.clearTimeoutFn,
      }),
    ).rejects.toThrow(/after 3000ms/);
  });

  it("always clears the timer, including on the timeout path", async () => {
    const timer = instantTimer();
    await expect(
      probeOnce(BASE_URL, "/", {
        fetch: hangingFetch(),
        setTimeoutFn: timer.setTimeoutFn,
        clearTimeoutFn: timer.clearTimeoutFn,
      }),
    ).rejects.toThrow();
    expect(timer.cleared).toHaveLength(1);
  });

  it("uses the real setTimeout/clearTimeout by default and does not time out on a normal fast response", async () => {
    const { fetchImpl } = mockFetch(() => okResponse());
    const response = await probeOnce(BASE_URL, "/", { fetch: fetchImpl });
    expect(response.status).toBe(200);
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

  it("rejects empty workerName/versionUuid/baseUrl/routes/releaseTag", async () => {
    const { fetchImpl } = mockFetch(() => okResponse());
    await expect(
      smokeWithVersionOverride(BASE_URL, "", UUID, ROUTES, RELEASE_TAG, { fetch: fetchImpl }),
    ).rejects.toThrow(/workerName must be a non-empty string/);
    await expect(
      smokeWithVersionOverride(BASE_URL, WORKER_NAME, "", ROUTES, RELEASE_TAG, {
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/versionUuid must be a non-empty string/);
    await expect(
      smokeWithVersionOverride("", WORKER_NAME, UUID, ROUTES, RELEASE_TAG, { fetch: fetchImpl }),
    ).rejects.toThrow(/baseUrl must be a non-empty string/);
    await expect(
      smokeWithVersionOverride(BASE_URL, WORKER_NAME, UUID, [], RELEASE_TAG, { fetch: fetchImpl }),
    ).rejects.toThrow(/routes must be a non-empty array/);
    await expect(
      smokeWithVersionOverride(BASE_URL, WORKER_NAME, UUID, ["not-a-route"], RELEASE_TAG, {
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/Invalid route/);
    await expect(
      smokeWithVersionOverride(BASE_URL, WORKER_NAME, UUID, ROUTES, "", { fetch: fetchImpl }),
    ).rejects.toThrow(/releaseTag must be a non-empty string/);
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

  it("rejects empty baseUrl/routes/releaseTag (shared probeRoutes validation)", async () => {
    const { fetchImpl } = mockFetch(() => okResponse());
    await expect(finalSmoke("", ROUTES, RELEASE_TAG, { fetch: fetchImpl })).rejects.toThrow(
      /baseUrl must be a non-empty string/,
    );
    await expect(finalSmoke(BASE_URL, [], RELEASE_TAG, { fetch: fetchImpl })).rejects.toThrow(
      /routes must be a non-empty array/,
    );
    await expect(finalSmoke(BASE_URL, ROUTES, "", { fetch: fetchImpl })).rejects.toThrow(
      /releaseTag must be a non-empty string/,
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

  it("rejects empty baseUrl/routes/releaseTag", async () => {
    const { fetchImpl } = mockFetch(() => okResponse());
    await expect(
      continuousProbe("", ROUTES, RELEASE_TAG, { fetch: fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow(/baseUrl must be a non-empty string/);
    await expect(
      continuousProbe(BASE_URL, [], RELEASE_TAG, { fetch: fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow(/routes must be a non-empty array/);
    await expect(
      continuousProbe(BASE_URL, ROUTES, "", { fetch: fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow(/releaseTag must be a non-empty string/);
  });

  it("rejects a non-positive-integer intervalMs or durationMs", async () => {
    const { fetchImpl } = mockFetch(() => okResponse());
    await expect(
      continuousProbe(BASE_URL, ROUTES, RELEASE_TAG, {
        fetch: fetchImpl,
        sleep: async () => {},
        intervalMs: 0,
      }),
    ).rejects.toThrow(/intervalMs must be a positive integer/);
    await expect(
      continuousProbe(BASE_URL, ROUTES, RELEASE_TAG, {
        fetch: fetchImpl,
        sleep: async () => {},
        durationMs: -1,
      }),
    ).rejects.toThrow(/durationMs must be a positive integer/);
  });

  it("falls back to the real setTimeout-based sleep when no sleep is injected", async () => {
    const { fetchImpl } = mockFetch(() => okResponse());
    // intervalMs/durationMs=1 keeps the single real wait imperceptible (<10ms)
    // while still exercising the actual default-adapter code path.
    const result = await continuousProbe(BASE_URL, ["/"], RELEASE_TAG, {
      fetch: fetchImpl,
      intervalMs: 1,
      durationMs: 1,
    });
    expect(result.ok).toBe(true);
  });
});
