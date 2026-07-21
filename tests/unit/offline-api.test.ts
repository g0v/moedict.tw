/**
 * Offline environment matrix for src/offline-api.ts.
 *
 * The module's Capacitor guard (`shouldUseOfflineApi`) and its monkey-patches
 * of `window.fetch`/`XMLHttpRequest.prototype.open` are evaluated once, at
 * import time — so every scenario here uses `vi.resetModules()` + a fresh
 * dynamic import with `window.Capacitor` set (or deliberately absent)
 * BEFORE the import, following the established pattern in
 * dictionary-cache.test.ts / scroll-position.test.ts / xref-switch-utils.test.ts.
 *
 * Covers:
 * 1. Capacitor present → fetch('/api/stroke-json/{cp}.json') is rewritten to
 *    the absolute production URL, no local `/stroke-json/*` probe, no
 *    staging→prod CDN fallback.
 * 2. Capacitor present → the legacy XHR `.open()` patch rewrites the same
 *    way, AND a non-stroke `.open()` call still opens through untouched
 *    (regression guard for the default-fallback branch).
 * 3. Capacitor absent → the module is a no-op: window.fetch is never
 *    patched, same-origin requests pass straight through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type CapacitorWindow = Window & { Capacitor?: unknown };

const originalFetchDescriptor = Object.getOwnPropertyDescriptor(window, "fetch");
// oxlint-disable-next-line typescript/unbound-method -- saved for later restore/comparison, never called unbound
const originalXHROpen = XMLHttpRequest.prototype.open;

function setCapacitor(present: boolean): void {
  if (present) {
    (window as CapacitorWindow).Capacitor = { isNative: true, getPlatform: () => "ios" };
  } else {
    delete (window as CapacitorWindow).Capacitor;
  }
}

async function importFresh(): Promise<void> {
  vi.resetModules();
  await import("../../src/offline-api.ts");
}

afterEach(() => {
  vi.resetModules();
  delete (window as CapacitorWindow).Capacitor;
  if (originalFetchDescriptor) {
    Object.defineProperty(window, "fetch", originalFetchDescriptor);
  }
  XMLHttpRequest.prototype.open = originalXHROpen;
  vi.restoreAllMocks();
});

describe("offline-api.ts — Capacitor present (fetch stroke routing)", () => {
  beforeEach(() => {
    setCapacitor(true);
  });

  it("rewrites /api/stroke-json/{cp}.json to the absolute production URL — no local probe, no CDN fallback", async () => {
    const calls: string[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    Object.defineProperty(window, "fetch", { value: fetchSpy, configurable: true, writable: true });

    await importFresh();
    const res = await window.fetch("/api/stroke-json/840c.json");

    expect(res.status).toBe(200);
    // Exactly one upstream fetch — straight to production, no local
    // /stroke-json/840c probe attempt and no *.rackcdn.com/CDN fallback URL.
    expect(calls).toEqual(["https://www.moedict.tw/api/stroke-json/840c.json"]);
    expect(calls.some((u) => u.includes("/stroke-json/840c") && !u.includes("/api/"))).toBe(false);
    expect(calls.some((u) => u.includes("rackcdn") || u.includes("r2-assets"))).toBe(false);
  });

  it("returns 400 for an invalid codepoint without ever calling fetch", async () => {
    const fetchSpy = vi.fn(async () => new Response("should not be called", { status: 200 }));
    Object.defineProperty(window, "fetch", { value: fetchSpy, configurable: true, writable: true });

    await importFresh();
    const res = await window.fetch("/api/stroke-json/xyz.json");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 503 (not an unhandled rejection) when the production fetch itself throws", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network down");
    });
    Object.defineProperty(window, "fetch", { value: fetchSpy, configurable: true, writable: true });

    await importFresh();
    const res = await window.fetch("/api/stroke-json/840c.json");
    expect(res.status).toBe(503);
  });
});

describe("offline-api.ts — Capacitor present (legacy XHR stroke routing)", () => {
  beforeEach(() => {
    setCapacitor(true);
  });

  it("rewrites XHR .open() for /api/stroke-json/{cp}.json to the absolute production URL", async () => {
    const openSpy = vi.fn(
      (
        _method: string,
        _url: string | URL,
        _async?: boolean,
        _user?: string | null,
        _pass?: string | null,
      ) => {
        // no-op stub — we only assert on the arguments passed through
      },
    );
    XMLHttpRequest.prototype.open = openSpy as unknown as typeof XMLHttpRequest.prototype.open;

    await importFresh();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/stroke-json/840c.json");

    expect(openSpy).toHaveBeenCalledTimes(1);
    const args = openSpy.mock.calls[0];
    expect(args[1]).toBe("https://www.moedict.tw/api/stroke-json/840c.json");
  });

  it("a non-stroke XHR .open() call still opens through unmodified (regression guard)", async () => {
    const openSpy = vi.fn(
      (
        _method: string,
        _url: string | URL,
        _async?: boolean,
        _user?: string | null,
        _pass?: string | null,
      ) => {
        // no-op stub
      },
    );
    XMLHttpRequest.prototype.open = openSpy as unknown as typeof XMLHttpRequest.prototype.open;

    await importFresh();
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/config");

    expect(openSpy).toHaveBeenCalledTimes(1);
    const args = openSpy.mock.calls[0];
    expect(args[1]).toBe("/api/config");
  });
});

describe("offline-api.ts — Capacitor absent (no-op guard)", () => {
  beforeEach(() => {
    setCapacitor(false);
  });

  it("never patches window.fetch when Capacitor is absent", async () => {
    const before = window.fetch;
    await importFresh();
    expect(window.fetch).toBe(before);
  });

  it("never patches XMLHttpRequest.prototype.open when Capacitor is absent", async () => {
    // oxlint-disable-next-line typescript/unbound-method -- saved for later restore/comparison, never called unbound
    const before = XMLHttpRequest.prototype.open;
    await importFresh();
    // oxlint-disable-next-line typescript/unbound-method -- comparison only, never called unbound
    expect(XMLHttpRequest.prototype.open).toBe(before);
  });

  it("same-origin /api/stroke-json requests pass straight through to the real fetch (unpatched)", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ seenUrl: url }), { status: 200 });
    });
    Object.defineProperty(window, "fetch", { value: fetchSpy, configurable: true, writable: true });

    await importFresh();
    const res = await window.fetch("/api/stroke-json/840c.json");
    const body = (await res.json()) as { seenUrl: string };
    // Unpatched: the exact same-origin path is forwarded verbatim — no
    // rewrite to the production absolute URL happens outside Capacitor.
    expect(body.seenUrl).toBe("/api/stroke-json/840c.json");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
