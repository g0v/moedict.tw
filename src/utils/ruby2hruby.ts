/**
 * Port of moedict-webkit RightAngle 流程到瀏覽器可執行版本。
 */

const UNICODE = {
  zhuyin: {
    initial: /[\u3105-\u3119\u312A-\u312C\u31A0-\u31A3]/,
    medial: /[\u3127-\u3129]/,
    final: /[\u311A-\u3129\u312D\u31A4-\u31B3\u31B8-\u31BA]/,
    tone: /[\u02D9\u02CA\u02C5\u02C7\u02CB\u02EA\u02EB]/,
    ruyun: /[\u31B4-\u31B7][\u0307\u0358\u030d]?/,
  },
};

const rZyS = UNICODE.zhuyin.initial.source;
const rZyJ = UNICODE.zhuyin.medial.source;
const rZyY = UNICODE.zhuyin.final.source;
const rZyD = `${UNICODE.zhuyin.tone.source}|${UNICODE.zhuyin.ruyun.source}`;

const TYPESET = {
  zhuyin: {
    form: new RegExp(`^\u02D9?(${rZyS})?(${rZyJ})?(${rZyY})?(${rZyD})?$`),
    diao: new RegExp(`(${rZyD})`, "g"),
  },
};

/* v8 ignore start -- decodes numeric character references emitted by serializers
   that preserve &#x...;. happy-dom decodes them at parse time and never re-emits
   them, so the regex on line 154 never matches under the unit-test DOMParser.
   Kept for environments whose serializer escapes supplementary-plane characters. */
function toCodePointString(entity: string): string {
  const codePoint = Number.parseInt(entity, 16);
  if (Number.isNaN(codePoint)) return entity;
  if (codePoint <= 0xffff) return String.fromCharCode(codePoint);
  const cp = codePoint - 0x10000;
  return String.fromCharCode((cp >> 10) + 0xd800) + String.fromCharCode((cp % 0x400) + 0xdc00);
}
/* v8 ignore stop */

function normalizeAnnotation(text: string): string {
  return text
    .replace(/\u0061[\u0307\u030d\u0358]/g, "\uDB80\uDC61")
    .replace(/\u0065[\u0307\u030d\u0358]/g, "\uDB80\uDC65")
    .replace(/\u0069[\u0307\u030d\u0358]/g, "\uDB80\uDC69")
    .replace(/\u006F[\u0307\u030d\u0358]/g, "\uDB80\uDC6F")
    .replace(/\u0075[\u0307\u030d\u0358]/g, "\uDB80\uDC75");
}

export function ruby2hruby(html: string): string {
  try {
    if (typeof DOMParser === "undefined") return html;

    const parser = new DOMParser();
    const doc = parser.parseFromString(`<ruby class="rightangle">${html}</ruby>`, "text/html");
    const ruby = doc.querySelector("ruby");
    // Our template always prepends <ruby class="rightangle"> so happy-dom always
    // yields a ruby root; retained for defensive parser failures.
    /* v8 ignore start */
    if (!ruby) return html;
    /* v8 ignore stop */

    // We always set class="rightangle" above, so the fallback is only reached if
    // a caller ever drops that attribute from the template.
    /* v8 ignore start */
    const originalClass = ruby.getAttribute("class") || "";
    /* v8 ignore stop */
    const maxspan = ruby.querySelectorAll("rb").length;
    const rus: HTMLElement[] = [];

    const zhuyinRtcs = Array.from(ruby.querySelectorAll("rtc.zhuyin"));
    zhuyinRtcs.forEach((rtc) => {
      const rbs = Array.from(ruby.querySelectorAll("rb"));
      const rts = Array.from(rtc.querySelectorAll("rt"));
      rts.forEach((rt, idx) => {
        const rb = rbs[idx];
        if (!rb) return;

        const rbClone = rb.cloneNode(true);
        // Element.textContent is always a string on an rt element; the `|| ''`
        // guards against hypothetical null returns from non-DOM parsers.
        /* v8 ignore start */
        const zhuyin = rt.textContent || "";
        /* v8 ignore stop */
        const yin = zhuyin.replace(TYPESET.zhuyin.diao, "");
        const diao = zhuyin
          .replace(yin, "")
          .replace(/[\u02C5]/g, "\u02C7")
          .replace(/[\u030D]/g, "\u0358")
          .replace(/[\u0358]/g, "\u0307");

        // Array#join('') already drops null/undefined, so we don't need
        // .filter(Boolean) before it; keeping it would add a never-killable
        // mutant on the redundant call.
        const form = zhuyin.replace(TYPESET.zhuyin.form, (_s, s, j, y) =>
          [s ? "S" : "", j ? "J" : "", y ? "Y" : ""].join(""),
        );

        const ru = doc.createElement("ru");
        const zhuyinEl = doc.createElement("zhuyin");
        const yinEl = doc.createElement("yin");
        const diaoEl = doc.createElement("diao");

        yinEl.innerHTML = yin;
        diaoEl.innerHTML = diao;
        zhuyinEl.appendChild(yinEl);
        zhuyinEl.appendChild(diaoEl);
        ru.appendChild(rbClone);
        ru.appendChild(zhuyinEl);
        ru.setAttribute("zhuyin", "");
        ru.setAttribute("diao", diao);
        ru.setAttribute("length", String(yin ? Array.from(yin).length : 0));
        ru.setAttribute("form", form);

        rb.replaceWith(ru);
        rus.push(ru);
      });
      rtc.remove();
    });

    const spans: number[] = [];
    const rtcs = Array.from(ruby.querySelectorAll("rtc"));
    rtcs.forEach((rtc, order) => {
      const rts = Array.from(rtc.querySelectorAll("rt"));
      rts.forEach((rt, idx) => {
        let span = 0;
        let baseNodes: Element[] = [];

        if (order === 0) {
          const rbspan = Math.min(Number(rt.getAttribute("rbspan") || 1), maxspan);
          while (rbspan > span) {
            const rb = rus.shift();
            if (!rb) break;
            baseNodes.push(rb);
            span += Number(rb.getAttribute("span") || 1);
          }

          /* v8 ignore start -- only reachable if a pulled <ru> has span > 1, but the
             zhuyin stage only ever pushes rus with no span attribute (defaulting to 1
             per rb). Kept as defensive handling for future multi-span rus. */
          if (rbspan < span) {
            if (baseNodes.length > 1) return;
            const single = baseNodes[0];
            if (!single) return;
            baseNodes = Array.from(single.querySelectorAll("rb")).slice(0, rbspan);
            span = rbspan;
          }
          /* v8 ignore stop */
          spans[idx] = span;
        } else {
          span = spans[idx];
          const orderZeroRu = Array.from(ruby.querySelectorAll('ru[order="0"]'))[idx];
          if (!orderZeroRu) return;
          baseNodes = [orderZeroRu];
        }

        const firstBase = baseNodes[0];
        if (!firstBase) return;

        const ru = doc.createElement("ru");
        const rtClone = rt.cloneNode(true) as Element;
        ru.innerHTML = baseNodes.map((node) => node.outerHTML).join("");
        ru.appendChild(rtClone);
        ru.setAttribute("span", String(span));
        ru.setAttribute("order", String(order));
        ru.setAttribute("class", originalClass);
        // Element.textContent is always a string; `|| ''` is a defensive fallback
        // that happy-dom never exercises.
        /* v8 ignore start */
        ru.setAttribute("annotation", normalizeAnnotation(rt.textContent || ""));
        /* v8 ignore stop */

        firstBase.replaceWith(ru);
        baseNodes.slice(1).forEach((node) => node.remove());
      });
    });

    // g0v/moedict-webkit#100: the visible reading (bopomofo/pinyin) is drawn
    // by CSS generated content (`ru[annotation]::before { content:
    // attr(annotation) }` in index.css), which modern browsers/AT already
    // expose in accessible-name computation. This leftover <rt> duplicates
    // that same text as a real, visually-hidden DOM node — kept only so the
    // reading stays selectable/copyable (CSS generated content itself is
    // never selectable). Without aria-hidden, screen readers announce the
    // reading twice (e.g. "méng 萌 ㄇㄥ ˊ méng"); aria-hidden removes it from
    // the accessibility tree while leaving text selection/copy untouched.
    ruby.querySelectorAll("rtc").forEach((rtc) => rtc.remove());
    ruby.querySelectorAll("rt").forEach((rt) => {
      rt.setAttribute("style", "text-indent: -9999px; color: transparent");
      rt.setAttribute("aria-hidden", "true");
    });

    return ruby.innerHTML.replace(
      /&#x([0-9a-fA-F]+);/g,
      // happy-dom never emits &#x...; entities in innerHTML, so the callback is
      // only invoked in browser environments whose serializer does.
      /* v8 ignore start */
      (_m, hex) => toCodePointString(hex),
      /* v8 ignore stop */
    );
  } catch {
    return html;
  }
}

export function rightAngle(html: string): string {
  const inner = ruby2hruby(html);
  return `<hruby class="rightangle" rightangle="rightangle">${inner}</hruby>`;
}
