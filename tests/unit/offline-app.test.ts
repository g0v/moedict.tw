import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { isOfflineApp } from "../../src/utils/offline-app";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete (window as Window & { Capacitor?: unknown }).Capacitor;
});

describe("isOfflineApp", () => {
  it("is false for the website build", () => {
    vi.stubEnv("VITE_MOEDICT_OFFLINE_APP", "");
    expect(isOfflineApp()).toBe(false);
  });

  it("is true when the offline build flag is set", () => {
    vi.stubEnv("VITE_MOEDICT_OFFLINE_APP", "1");
    expect(isOfflineApp()).toBe(true);
  });

  it("is true inside the Capacitor shell even without the build flag", () => {
    vi.stubEnv("VITE_MOEDICT_OFFLINE_APP", "");
    (window as Window & { Capacitor?: unknown }).Capacitor = {};
    expect(isOfflineApp()).toBe(true);
  });

  it("is false when there is no window and no build flag", () => {
    vi.stubEnv("VITE_MOEDICT_OFFLINE_APP", "");
    vi.stubGlobal("window", undefined);
    expect(isOfflineApp()).toBe(false);
  });
});
