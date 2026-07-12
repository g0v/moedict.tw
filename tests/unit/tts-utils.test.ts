/**
 * Coverage for src/utils/tts-utils.ts — TTS helpers used by the
 * Eng/Fr/De translation pronunciation buttons. The module was 0% at
 * unit level; it isn't exercised by E2E either because Playwright
 * doesn't load voices in headless Chromium.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanTextForTTS, getLanguageCode, speakText } from "../../src/utils/tts-utils";

interface SpeakCall {
  text: string;
  lang: string;
  voice?: SpeechSynthesisVoice;
  rate: number;
  pitch?: number;
  volume: number;
}

let speakCalls: SpeakCall[] = [];
let cancelCalls = 0;
let voices: SpeechSynthesisVoice[] = [];
let voicesChangedHandler: (() => void) | null = null;

class FakeUtterance {
  text: string;
  lang = "";
  voice: SpeechSynthesisVoice | undefined;
  volume = 1;
  rate = 1;
  pitch = 1;
  constructor(text: string) {
    this.text = text;
  }
}

interface InstallSynthesisOptions {
  getVoices?: () => SpeechSynthesisVoice[];
  cancel?: () => void;
  onvoiceschangedSetterThrows?: boolean;
}

function installSynthesis(options: InstallSynthesisOptions = {}) {
  if (typeof globalThis.window === "undefined") return;
  const synthesis = {
    getVoices: options.getVoices ?? (() => voices),
    cancel:
      options.cancel ??
      (() => {
        cancelCalls += 1;
      }),
    speak: (u: FakeUtterance) => {
      speakCalls.push({
        text: u.text,
        lang: u.lang,
        voice: u.voice,
        rate: u.rate,
        pitch: u.pitch,
        volume: u.volume,
      });
    },
    get onvoiceschanged() {
      return voicesChangedHandler ?? (() => undefined);
    },
  };
  if (options.onvoiceschangedSetterThrows) {
    Object.defineProperty(synthesis, "onvoiceschanged", {
      configurable: true,
      set() {
        throw new Error("setter failed");
      },
      get() {
        return voicesChangedHandler ?? (() => undefined);
      },
    });
  } else {
    Object.defineProperty(synthesis, "onvoiceschanged", {
      configurable: true,
      set(handler: () => void) {
        voicesChangedHandler = handler;
      },
      get() {
        return voicesChangedHandler ?? (() => undefined);
      },
    });
  }
  // @ts-expect-error stubbing window-level TTS for happy-dom
  globalThis.window.speechSynthesis = synthesis;
  // @ts-expect-error same
  globalThis.window.SpeechSynthesisUtterance = FakeUtterance;
}

function uninstallSynthesis() {
  if (typeof globalThis.window === "undefined") return;
  // @ts-expect-error clean up stubs
  delete globalThis.window.speechSynthesis;
  // @ts-expect-error same
  delete globalThis.window.SpeechSynthesisUtterance;
}

function voice(name: string, lang: string): SpeechSynthesisVoice {
  return { name, lang, default: false, localService: true, voiceURI: name } as SpeechSynthesisVoice;
}

function throwingVoice(): SpeechSynthesisVoice {
  return {
    get name() {
      throw new Error("name failed");
    },
    get lang() {
      throw new Error("lang failed");
    },
    default: false,
    localService: true,
    voiceURI: "throwing",
  } as unknown as SpeechSynthesisVoice;
}

beforeEach(() => {
  speakCalls = [];
  cancelCalls = 0;
  voices = [];
  voicesChangedHandler = null;
  installSynthesis();
});

afterEach(() => {
  uninstallSynthesis();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getLanguageCode", () => {
  it.each([
    ["英", "en-US"],
    ["法", "fr-FR"],
    ["德", "de-DE"],
    ["other", "en-US"],
    ["", "en-US"],
  ])("%s → %s", (label, expected) => {
    expect(getLanguageCode(label)).toBe(expected);
  });
});

describe("cleanTextForTTS", () => {
  it("strips HTML tags", () => {
    expect(cleanTextForTTS("hello <b>world</b>")).toBe("hello world");
  });

  it('removes ", CL:" trailers common in CFDict entries', () => {
    expect(cleanTextForTTS("to cut, CL: 個")).toBe("to cut");
  });

  it("drops content after a pipe until the next punctuation/space", () => {
    expect(cleanTextForTTS("a|orthographic-variant b")).toBe("a b");
  });

  it("strips single-letter bracket markers like (A) (B) and collapses spaces", () => {
    expect(cleanTextForTTS("(A) primary (B) secondary")).toBe("primary secondary");
  });

  it("strips non-ASCII characters", () => {
    expect(cleanTextForTTS("café naïve")).toBe("caf nave");
  });

  it("collapses repeated whitespace", () => {
    expect(cleanTextForTTS("a   b\tc\n\nd")).toBe("a b c d");
  });

  it("accepts array input and joins with commas before cleaning", () => {
    expect(cleanTextForTTS(["hello", "world"])).toBe("hello, world");
  });

  it("coerces nullish input to an empty string", () => {
    expect(cleanTextForTTS(undefined)).toBe("");
    expect(cleanTextForTTS(null)).toBe("");
  });

  it("stringifies numeric and boolean input via String()", () => {
    expect(cleanTextForTTS(42)).toBe("42");
    expect(cleanTextForTTS(true)).toBe("true");
  });

  it("ignores non-primitive input that has no meaningful string form", () => {
    expect(cleanTextForTTS({ not: "a string" })).toBe("");
  });
});

describe("speakText", () => {
  it("speaks the cleaned text with en-US lang for 英 (voices already loaded)", () => {
    voices = [voice("US Voice", "en-US")];
    speakText("英", "hello <b>world</b>");
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].text).toBe("hello world");
    expect(speakCalls[0].lang).toBe("en-US");
  });

  it("assigns the preferred EN voice (Samantha/Alex) when available", () => {
    voices = [
      voice("Fred", "en-US"),
      voice("Compact Voice", "en-US"),
      voice("Samantha", "en-US"),
      voice("Alex", "en-US"),
    ];
    speakText("英", "hi");
    expect(speakCalls[0].voice?.name).toBe("Samantha");
  });

  it("falls back to en-US → en-GB → en-AU when no preferred voice is present", () => {
    voices = [
      voice("Google UK English", "en-GB"),
      voice("AU Voice", "en-AU"),
      voice("US Voice", "en-US"),
    ];
    speakText("英", "hi");
    expect(speakCalls[0].voice?.lang).toBe("en-US");
  });

  it("filters out Compact / Fred voices", () => {
    voices = [voice("Compact Bob", "en-US"), voice("Fred", "en-US"), voice("Good Voice", "en-US")];
    speakText("英", "hi");
    expect(speakCalls[0].voice?.name).toBe("Good Voice");
  });

  it("defers EN speak until voices load when getVoices() returns empty", () => {
    voices = [];
    speakText("英", "hi");
    // No synchronous speak — handler registered for voiceschanged.
    expect(speakCalls).toHaveLength(0);
    expect(voicesChangedHandler).toBeTypeOf("function");
    // Fire voiceschanged with populated voices — then speak should happen.
    voices = [voice("Samantha", "en-US")];
    voicesChangedHandler?.();
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].voice?.name).toBe("Samantha");
    expect(cancelCalls).toBe(1); // cancels the initial utterance before re-speaking
  });

  it("picks the preferred FR voice (Google fr-FR > fr-FR > fr-CA)", () => {
    voices = [
      voice("Google français", "fr-FR"),
      voice("Amelie", "fr-CA"),
      voice("Generic", "fr-FR"),
    ];
    speakText("法", "bonjour");
    expect(speakCalls[0].voice?.name).toBe("Google français");
  });

  it("defers FR speak until voiceschanged when getVoices() is empty", () => {
    voices = [];
    speakText("法", "bonjour");
    expect(speakCalls).toHaveLength(0);
    voices = [voice("Amelie", "fr-CA")];
    voicesChangedHandler?.();
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].voice?.lang).toBe("fr-CA");
  });

  it("ignores a FR voiceschanged event when no French voice is available yet", () => {
    voices = [];
    speakText("法", "bonjour");
    expect(voicesChangedHandler).toBeTypeOf("function");
    voices = [];
    voicesChangedHandler?.();
    expect(speakCalls).toHaveLength(0);
  });

  it("handles a FR voiceschanged event when getVoices is missing", () => {
    // @ts-expect-error force the ternary fallback inside the handler
    delete globalThis.window.speechSynthesis.getVoices;
    speakText("法", "bonjour");
    expect(voicesChangedHandler).toBeTypeOf("function");
    voicesChangedHandler?.();
    expect(speakCalls).toHaveLength(0);
  });

  it("falls back cleanly when deferred FR voices resolve to null", () => {
    installSynthesis({ getVoices: () => null as unknown as SpeechSynthesisVoice[] });
    speakText("法", "bonjour");
    expect(voicesChangedHandler).toBeTypeOf("function");
    voicesChangedHandler?.();
    expect(speakCalls).toHaveLength(0);
  });

  it("speaks 德 entries with de-DE regardless of voice list", () => {
    voices = [voice("Anna", "de-DE")];
    speakText("德", "hallo");
    expect(speakCalls[0].lang).toBe("de-DE");
  });

  it("noops when speechSynthesis is unavailable (SSR-ish)", () => {
    uninstallSynthesis();
    expect(() => speakText("英", "hi")).not.toThrow();
    expect(speakCalls).toHaveLength(0);
  });

  it("noops when window itself is unavailable", () => {
    vi.stubGlobal("window", undefined);
    expect(() => speakText("英", "hi")).not.toThrow();
    expect(speakCalls).toHaveLength(0);
  });

  it("noops when SpeechSynthesisUtterance is unavailable", () => {
    // @ts-expect-error intentionally remove the constructor to hit the guard
    delete globalThis.window.SpeechSynthesisUtterance;
    speakText("英", "hi");
    expect(speakCalls).toHaveLength(0);
  });

  it("noops when the cleaned text is empty", () => {
    speakText("英", "<tag></tag>");
    expect(speakCalls).toHaveLength(0);
  });

  it("uses Firefox rate and pitch tweaks for English voices", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Gecko/20100101 Firefox/124.0" });
    voices = [voice("US Voice", "en-US")];
    speakText("英", "hello");
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].rate).toBe(0.95);
    expect(speakCalls[0].pitch).toBe(1.02);
  });

  it("treats a missing navigator as non-Firefox", () => {
    vi.stubGlobal("navigator", undefined);
    voices = [voice("US Voice", "en-US")];
    speakText("英", "hello");
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].rate).toBe(1);
    expect(speakCalls[0].pitch).toBe(1);
  });

  it.each([
    ["Alex", [voice("Fred", "en-US"), voice("Alex", "en-US"), voice("US Voice", "en-US")]],
    ["en-GB", [voice("UK Voice", "en-GB"), voice("NZ Voice", "en-NZ")]],
    ["en-AU", [voice("AU Voice", "en-AU"), voice("NZ Voice", "en-NZ")]],
    ["first available", [voice("Fallback 1", "en-ZA"), voice("Fallback 2", "en-CA")]],
  ])("selects the %s EN voice fallback", (_label, voiceList) => {
    voices = voiceList;
    speakText("英", "hi");
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].voice?.name).toBe(
      voiceList[0].name === "Fred" ? "Alex" : voiceList[0].name,
    );
  });

  it("handles an EN voice with an empty name", () => {
    voices = [voice("", "en-US"), voice("US Voice", "en-US")];
    speakText("英", "hi");
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].lang).toBe("en-US");
  });

  it("prefers fr-FR when a Google voice is not present", () => {
    voices = [voice("Amelie", "fr-CA"), voice("Jean", "fr-FR")];
    speakText("法", "bonjour");
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].voice?.lang).toBe("fr-FR");
  });

  it("skips Google voices unless they are fr-FR", () => {
    voices = [voice("Google français", "fr-CA"), voice("Jean", "fr-FR")];
    speakText("法", "bonjour");
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].voice?.name).toBe("Jean");
  });

  it("handles French voices with empty names in the Google selector", () => {
    voices = [voice("", "fr-FR"), voice("Google français", "fr-FR")];
    speakText("法", "bonjour");
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].voice?.name).toBe("Google français");
  });

  it("falls back to the first French voice when only non fr-FR / fr-CA voices exist", () => {
    voices = [voice("Belgium", "fr-BE"), voice("Swiss", "fr-CH")];
    speakText("法", "bonjour");
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].voice?.name).toBe("Belgium");
  });

  it("swallows FR voice-selection failures and still speaks with the default language", () => {
    voices = [throwingVoice()];
    speakText("法", "bonjour");
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].lang).toBe("fr-FR");
    expect(speakCalls[0].voice).toBeUndefined();
  });

  it("handles a getVoices failure and recovers once voices become available", () => {
    let firstCall = true;
    installSynthesis({
      getVoices: () => {
        if (firstCall) {
          firstCall = false;
          throw new Error("getVoices failed");
        }
        return voices;
      },
    });
    voices = [];
    speakText("英", "hi");
    expect(speakCalls).toHaveLength(0);
    expect(voicesChangedHandler).toBeTypeOf("function");
    voices = [voice("Samantha", "en-US")];
    voicesChangedHandler?.();
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].voice?.name).toBe("Samantha");
  });

  it("swallows onvoiceschanged assignment failures", () => {
    installSynthesis({ onvoiceschangedSetterThrows: true });
    voices = [];
    expect(() => speakText("英", "hi")).not.toThrow();
    expect(voicesChangedHandler).toBeNull();
    expect(speakCalls).toHaveLength(0);
  });

  it("swallows cancel failures in deferred English speech", () => {
    installSynthesis({
      cancel: () => {
        cancelCalls += 1;
        throw new Error("cancel failed");
      },
    });
    voices = [];
    speakText("英", "hi");
    expect(voicesChangedHandler).toBeTypeOf("function");
    voices = [voice("Samantha", "en-US")];
    voicesChangedHandler?.();
    expect(speakCalls).toHaveLength(1);
  });

  it("ignores an EN voiceschanged event when no English voice is available yet", () => {
    voices = [];
    speakText("英", "hi");
    expect(voicesChangedHandler).toBeTypeOf("function");
    voices = [];
    voicesChangedHandler?.();
    expect(speakCalls).toHaveLength(0);
  });

  it("handles a deferred EN voiceschanged event when getVoices is missing", () => {
    // @ts-expect-error force the ternary fallback inside the handler
    delete globalThis.window.speechSynthesis.getVoices;
    voices = [];
    speakText("英", "hi");
    expect(voicesChangedHandler).toBeTypeOf("function");
    voicesChangedHandler?.();
    expect(speakCalls).toHaveLength(0);
  });

  it("falls back cleanly when deferred EN voices resolve to null", () => {
    installSynthesis({ getVoices: () => null as unknown as SpeechSynthesisVoice[] });
    speakText("英", "hi");
    expect(voicesChangedHandler).toBeTypeOf("function");
    voicesChangedHandler?.();
    expect(speakCalls).toHaveLength(0);
  });

  it("uses Firefox rate and pitch tweaks in the deferred EN path", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Gecko/20100101 Firefox/124.0" });
    voices = [];
    speakText("英", "hi");
    expect(voicesChangedHandler).toBeTypeOf("function");
    voices = [voice("US Voice", "en-US")];
    voicesChangedHandler?.();
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].rate).toBe(0.95);
    expect(speakCalls[0].pitch).toBe(1.02);
  });

  it("swallows EN voice-selection failures and still speaks with the default language", () => {
    voices = [throwingVoice()];
    speakText("英", "hi");
    expect(speakCalls).toHaveLength(1);
    expect(speakCalls[0].lang).toBe("en-US");
    expect(speakCalls[0].voice).toBeUndefined();
  });

  it("warns when utterance construction throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    class ThrowingUtterance {
      constructor() {
        throw new Error("boom");
      }
    }
    // @ts-expect-error force the outer catch branch
    globalThis.window.SpeechSynthesisUtterance = ThrowingUtterance;
    expect(() => speakText("英", "hi")).not.toThrow();
    expect(speakCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("[TTS] 語音播放失敗", expect.any(Error));
  });
});
