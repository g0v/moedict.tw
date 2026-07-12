/**
 * 順序不變量測試 — <h1 className="title"> 內 sibling 順序：
 *   children（ruby/title）→ small.youyin → span.audioBlock →
 *   small.alternative → small.reading-type
 *
 * 前四個節點依 legacy `~/w/moedict-webkit/view.ls:132-158` 的 ground truth；
 * 新增的 reading-type 固定放在最後。
 * 過去曾有 commit 把 .alternative 插到 .audioBlock 之前，造成播放鍵被
 * block-level 的 .alternative 擠到下方（視覺回歸）。本測試把順序固化。
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { TitlePronunciation } from "../../src/components/TitlePronunciation";

const noop = () => {};

function render(overrides: Record<string, unknown> = {}): string {
  const defaults = {
    children: <span data-testid="ruby">字</span>,
    lang: "t" as const,
    youyin: "又" as string | undefined,
    bAlt: "ㆢㄧㆷ͘" as string | undefined,
    pAlt: "ji̍h" as string | undefined,
    pronunAudioId: "12345" as string | undefined,
    isPlaying: false,
    onToggleAudio: noop,
    readingType: "文" as string | undefined,
  };
  const props = { ...defaults, ...overrides };
  return renderToStaticMarkup(<TitlePronunciation {...props} />);
}

describe("TitlePronunciation 順序不變量", () => {
  it("(a) t-lang 全部項目齊全時，既有順序不變且 reading-type 固定在最後", () => {
    const html = render();
    const iChildren = html.indexOf('data-testid="ruby"');
    const iYouyin = html.indexOf('class="youyin"');
    const iAudioBlock = html.indexOf('class="audioBlock"');
    const iAlternative = html.indexOf('class="alternative"');
    const iReadingType = html.indexOf('class="reading-type"');

    // 全部都應該存在
    expect(iChildren).toBeGreaterThanOrEqual(0);
    expect(iYouyin).toBeGreaterThanOrEqual(0);
    expect(iAudioBlock).toBeGreaterThanOrEqual(0);
    expect(iAlternative).toBeGreaterThanOrEqual(0);
    expect(iReadingType).toBeGreaterThanOrEqual(0);

    // 順序不變量
    expect(iChildren).toBeLessThan(iYouyin);
    expect(iYouyin).toBeLessThan(iAudioBlock);
    expect(iAudioBlock).toBeLessThan(iAlternative);
    expect(iAlternative).toBeLessThan(iReadingType);
  });

  it("(b) 無 bAlt/pAlt 時不渲染 small.alternative", () => {
    const html = render({ bAlt: undefined, pAlt: undefined });
    expect(html).not.toContain('class="alternative"');
    expect(html).not.toContain('class="pinyin"');
    expect(html).not.toContain('class="bopomofo"');
  });

  it("(c) lang=h 時不渲染 pinyin span（bopomofo span 仍渲染）", () => {
    const html = render({ lang: "h", pronunAudioId: undefined });
    // alternative 仍存在（因為有 bAlt）
    expect(html).toContain('class="alternative"');
    // bopomofo span 存在
    expect(html).toContain('class="bopomofo"');
    // pinyin span 不存在
    expect(html).not.toContain('class="pinyin"');
  });

  it("(c2) lang=h 且 pronunAudioId=undefined 時不渲染 audioBlock", () => {
    const html = render({ lang: "h", pronunAudioId: undefined });
    expect(html).not.toContain('class="audioBlock"');
  });

  it("(d) 無 pronunAudioId 時不渲染 span.audioBlock", () => {
    const html = render({ pronunAudioId: undefined });
    expect(html).not.toContain('class="audioBlock"');
    expect(html).not.toContain("playAudio");
  });

  it("顯示 TWBLG 讀音分類的完整可存取標籤", () => {
    const html = render({ readingType: "文" });
    expect(html).toContain('class="reading-type"');
    expect(html).toContain('title="文讀音（文言音）"');
    expect(html).toContain('aria-label="文讀音（文言音）"');
    expect(html).toContain(">文</small>");
  });

  it("沒有分類或非台語條目時不顯示 reading-type", () => {
    expect(render({ readingType: undefined })).not.toContain('class="reading-type"');
    expect(render({ lang: "a", readingType: "文" })).not.toContain('class="reading-type"');
  });

  it("未知分類仍原樣顯示，不靜默丟失上游資料", () => {
    const html = render({ readingType: "新" });
    expect(html).toContain('title="新"');
    expect(html).toContain(">新</small>");
  });

  it("audioBlock 內含 role=button, tabIndex=0, playAudio class, 播放發音 aria-label/title", () => {
    const html = render({ isPlaying: false });
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('class="playAudio part-of-speech"');
    expect(html).toContain('aria-label="播放發音"');
    expect(html).toContain('title="播放發音"');
  });

  it("isPlaying=true 時 aria-label/title 切換為 停止播放", () => {
    const html = render({ isPlaying: true });
    expect(html).toContain('aria-label="停止播放"');
    expect(html).toContain('title="停止播放"');
  });

  it("youyin 不存在時不渲染 small.youyin", () => {
    const html = render({ youyin: undefined });
    expect(html).not.toContain('class="youyin"');
  });
});
