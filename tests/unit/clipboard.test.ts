/**
 * Unit tests for writeTextToClipboard — covers every branch of the
 * async-clipboard-then-execCommand-fallback state machine without a real
 * browser (happy-dom's execCommand is a no-op stub, so we override it
 * per-test to simulate both the legacy-copy success and failure paths).
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { writeTextToClipboard } from "../../src/utils/clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Restore whatever execCommand happy-dom ships by default between tests.
  Reflect.deleteProperty(document, "execCommand" as never);
});

describe("writeTextToClipboard — input guard", () => {
  it("returns false immediately for empty text without touching any clipboard API", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await writeTextToClipboard("")).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("writeTextToClipboard — modern Clipboard API path", () => {
  it("returns true when navigator.clipboard.writeText succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await writeTextToClipboard("萌")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("萌");
  });

  it("falls through to the legacy path when navigator.clipboard.writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;
    expect(await writeTextToClipboard("萌")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("萌");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls through to the legacy path when navigator.clipboard is undefined", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;
    expect(await writeTextToClipboard("萌")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls through to the legacy path when navigator.clipboard.writeText is not a function", async () => {
    vi.stubGlobal("navigator", { clipboard: {} });
    document.execCommand = vi.fn().mockReturnValue(true);
    expect(await writeTextToClipboard("萌")).toBe(true);
  });
});

describe("writeTextToClipboard — legacy execCommand fallback", () => {
  it("returns false when document.execCommand is not a function", async () => {
    vi.stubGlobal("navigator", {});
    // happy-dom always defines execCommand, so explicitly strip it to
    // exercise the `typeof document.execCommand !== "function"` guard.
    Reflect.deleteProperty(document, "execCommand" as never);
    expect(await writeTextToClipboard("萌")).toBe(false);
  });

  it("creates a temporary readonly textarea, copies via execCommand, and cleans it up", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn().mockReturnValue(true);
    document.execCommand = execCommand;

    const result = await writeTextToClipboard("測試字串");

    expect(result).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    // The scratch textarea must be removed from the DOM after the copy.
    expect(document.querySelectorAll("textarea").length).toBe(0);
  });

  it("returns false when execCommand('copy') reports failure", async () => {
    vi.stubGlobal("navigator", {});
    document.execCommand = vi.fn().mockReturnValue(false);
    expect(await writeTextToClipboard("萌")).toBe(false);
  });

  it("returns false and still cleans up when execCommand throws", async () => {
    vi.stubGlobal("navigator", {});
    document.execCommand = vi.fn().mockImplementation(() => {
      throw new Error("execCommand blocked");
    });
    expect(await writeTextToClipboard("萌")).toBe(false);
    expect(document.querySelectorAll("textarea").length).toBe(0);
  });

  it("restores the prior selection ranges and re-focuses the previously active element", async () => {
    vi.stubGlobal("navigator", {});
    document.execCommand = vi.fn().mockReturnValue(true);

    const host = document.createElement("button");
    document.body.appendChild(host);
    host.focus();
    const focusSpy = vi.spyOn(host, "focus");

    // Seed a real Selection with at least one Range so the restore branch
    // (selection.removeAllRanges + re-added ranges) actually executes.
    const marker = document.createElement("span");
    marker.textContent = "x";
    document.body.appendChild(marker);
    const range = document.createRange();
    range.selectNodeContents(marker);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(await writeTextToClipboard("萌")).toBe(true);

    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(selection?.rangeCount).toBeGreaterThan(0);

    host.remove();
    marker.remove();
  });

  it("handles a null window.getSelection() without throwing", async () => {
    vi.stubGlobal("navigator", {});
    document.execCommand = vi.fn().mockReturnValue(true);
    const originalGetSelection = window.getSelection.bind(window);
    window.getSelection = () => null;
    try {
      expect(await writeTextToClipboard("萌")).toBe(true);
    } finally {
      window.getSelection = originalGetSelection;
    }
  });
});
