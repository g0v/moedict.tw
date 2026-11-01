import { describe, expect, it } from "vite-plus/test";
import { rightAngle } from "../../src/utils/ruby2hruby";
import { sanitizeDictionaryHtml } from "../../src/utils/sanitize-dictionary-html";

describe("sanitizeDictionaryHtml", () => {
  it("keeps ruby pronunciation markup and its accessible reading", () => {
    const ruby = rightAngle(
      '<rb>萌</rb><rtc class="zhuyin"><rt>ㄇㄥˊ</rt></rtc>' +
        '<rtc class="romanization"><rt>méng</rt></rtc>',
    );
    const safe = sanitizeDictionaryHtml(ruby);
    expect(safe).toContain('<hruby class="rightangle" rightangle="rightangle">');
    expect(safe).toContain("<ru");
    expect(safe).toContain("<zhuyin>");
    expect(safe).toContain("<yin>ㄇㄥ</yin>");
    expect(safe).toContain('aria-hidden="true"');
    expect(safe).toContain('style="text-indent:-9999px;color:transparent"');
  });

  it("keeps dictionary formatting and same-site links", () => {
    const safe = sanitizeDictionaryHtml(
      '<br><sup>1</sup><table><tr><td colspan="2">字</td></tr></table>' +
        '<a href="./#萌">萌</a><a href="https://www.moedict.tw/萌">本站</a>',
    );
    expect(safe).toContain("<br>");
    expect(safe).toContain("<sup>1</sup>");
    expect(safe).toContain('colspan="2"');
    expect(safe).toContain('href="./#萌"');
    expect(safe).toContain('href="https://www.moedict.tw/萌"');
  });

  it("removes active markup, event handlers, unsafe styles, and off-site links", () => {
    const safe = sanitizeDictionaryHtml(
      '<img src=x onerror="alert(1)"><script>alert(2)</script>' +
        '<span style="position:fixed;background:url(javascript:alert(3))" onclick="alert(4)">字</span>' +
        '<a href="javascript:alert(5)" onmouseover="alert(6)">甲</a>' +
        '<a href="//evil.example/">乙</a>',
    );
    expect(safe).toContain("字");
    expect(safe).toContain("甲");
    expect(safe).toContain("乙");
    expect(safe).not.toMatch(
      /<img|<script|onerror|onclick|onmouseover|position:fixed|javascript:|evil\.example/,
    );
  });

  it("keeps nested foreign markup and encoded schemes inert", () => {
    const safe = sanitizeDictionaryHtml(
      "<svg><textarea></textarea/><img src=x onerror=alert(1)></svg>" +
        '<a href="&#x6a;avascript:alert(2)">文字</a>',
    );
    const doc = new DOMParser().parseFromString(safe, "text/html");
    expect(doc.querySelector("svg, textarea, img, [onerror], [href]")).toBeNull();
    expect(doc.body.textContent).toContain("文字");
  });

  it("keeps only lookup anchors in synonym and antonym fields", () => {
    const safe = sanitizeDictionaryHtml(
      '<em>甲</em><a href="./#乙" class="other">乙</a><a href="/丙">丙</a>',
      true,
    );
    expect(safe).toContain("甲");
    expect(safe).toContain('<a href="./#乙">乙</a>');
    expect(safe).not.toContain("<em");
    expect(safe).not.toContain('href="/丙"');
    expect(safe).not.toContain("class=");
  });

  it("drops empty, missing, and malformed link targets", () => {
    const safe = sanitizeDictionaryHtml(
      '<a href="">空</a><a>缺</a><a href="http://[broken">錯</a>',
    );
    expect(safe).toBe("空缺錯");
  });

  it("drops comments and content beyond the nesting limit", () => {
    const deeplyNested = `${"<div>".repeat(51)}底${"</div>".repeat(51)}`;
    const safe = sanitizeDictionaryHtml(`<!--source note-->${deeplyNested}`);
    expect(safe).not.toContain("source note");
    expect(safe).not.toContain("底");
    expect((safe.match(/<div>/g) || []).length).toBe(50);
  });

  it("drops unsupported accessibility attributes while keeping text", () => {
    const safe = sanitizeDictionaryHtml('<span aria-hidden="false">可見</span>');
    expect(safe).toBe("<span>可見</span>");
  });
});
