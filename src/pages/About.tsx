/**
 * 關於頁面 React 組件
 * 復刻原專案 moedict-webkit 的 about.html 頁面
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SvgIcon } from "../components/SvgIcon";
import { applyHeadByPath, applyHeadToDocument, resolveHeadByPath } from "../ssr/head";
import { LEGACY_STYLESHEET_VERSION } from "../utils/media-cdn";
import "./About.css";

// 動態載入外部樣式
function loadExternalStyles(r2Endpoint: string) {
  if (!r2Endpoint) return;

  // 檢查是否已經載入過
  const existingLink = document.querySelector(`link[data-r2-styles]`);
  if (existingLink) return;

  // 載入原專案的樣式（通過 Worker 代理）
  const link = document.createElement("link");
  link.rel = "stylesheet";
  // 使用 /assets/ 路徑，讓 Worker 代理請求
  link.href = `/assets/styles.css?v=${LEGACY_STYLESHEET_VERSION}`;
  link.setAttribute("data-r2-styles", "true");
  document.head.appendChild(link);
}

interface AboutProps {
  assetBaseUrl?: string;
}

function isCapacitorApp() {
  return (
    typeof window !== "undefined" && Boolean((window as Window & { Capacitor?: unknown }).Capacitor)
  );
}

/** 使用說明截圖：放在 public/images/guide/，檔名為中文故以 encodeURIComponent 編碼（#95） */
const GUIDE_IMAGE_BASE = "/images/guide/";
function guideSrc(fileName: string): string {
  return GUIDE_IMAGE_BASE + encodeURIComponent(fileName);
}

interface GuideFigureProps {
  src: string;
  alt: string;
  caption?: string;
  onOpen: (src: string, alt: string) => void;
}

function GuideFigure({ src, alt, caption, onOpen }: GuideFigureProps) {
  return (
    <figure className="guide-figure">
      <button
        type="button"
        className="guide-figure-button"
        onClick={() => onOpen(src, alt)}
        aria-label={`放大檢視：${alt}`}
      >
        <img src={src} alt={alt} loading="lazy" />
      </button>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

/**
 * 關於頁面組件
 */
export function About({ assetBaseUrl }: AboutProps) {
  const [r2Endpoint, setR2Endpoint] = useState<string>("");
  const [bookmarkHint, setBookmarkHint] = useState<string>("");
  const showWebOnlyActions = !isCapacitorApp();
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const openLightbox = (src: string, alt: string) => setLightbox({ src, alt });

  // 放大檢視時按 Esc 關閉
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  useEffect(() => {
    // 如果沒有傳入 assetBaseUrl，從 API 取得
    if (assetBaseUrl) {
      const endpoint = assetBaseUrl.replace(/\/$/, "");
      setR2Endpoint(endpoint);
      loadExternalStyles(endpoint);
    } else {
      // wrangler vars.ASSET_BASE_URL → /api/config.assetBaseUrl
      fetch("/api/config")
        .then((res) => res.json())
        .then((data: { assetBaseUrl?: string }) => {
          if (data.assetBaseUrl) {
            const endpoint = data.assetBaseUrl.replace(/\/$/, "");
            setR2Endpoint(endpoint);
            loadExternalStyles(endpoint);
          }
        })
        .catch((err) => {
          console.error("取得 ASSET_BASE_URL 失敗:", err);
        });
    }
  }, [assetBaseUrl]);

  // R2 公開端點（由外部注入或從 API 取得）
  const R2_ENDPOINT = r2Endpoint;

  // 設定 body 類別
  useEffect(() => {
    document.body.id = "moedict";
    document.body.className = "about web";
    applyHeadByPath("/about");
    return () => {
      document.body.id = "";
      document.body.className = "";
      applyHeadToDocument(resolveHeadByPath("/"));
    };
  }, []);

  return (
    <div className="about-page">
      {/* 主要內容 */}
      <div style={{ textAlign: "center" }}>
        {R2_ENDPOINT && (
          <img
            style={{ marginTop: "25px", marginBottom: "15px", background: "white" }}
            title="萌典首頁"
            src="/assets/images/icon.png"
            width="50%"
            className="logo"
            alt="萌典 Logo"
          />
        )}
      </div>

      <div className="content">
        <p className="how-to-use-link" style={{ textAlign: "center", margin: "0 0 1.5em" }}>
          <a href="#how-to-use" className="btn btn-info">
            <SvgIcon name="book" size={14} style={{ marginRight: 6 }} aria-hidden="true" />
            萌典功能使用說明
          </a>
        </p>
        <p>
          <Link to="/" className="home">
            萌典
          </Link>
          共收錄十六萬筆臺灣華語、兩萬筆臺灣台語、一萬四千筆臺灣客語條目，並支援「自動完成」功能及
          <span style={{ whiteSpace: "nowrap" }}>「%_ *? ^.$」</span>等萬用字元。
        </p>
        <p>定義裡的每個字詞都可以點擊連到說明。</p>
        <p>
          源碼、其他平台版本、API 及原始資料等，均可在{" "}
          <a target="_blank" href="https://github.com/g0v/moedict.tw" rel="noopener noreferrer">
            GitHub
          </a>{" "}
          取得。
        </p>
        {import.meta.env.VITE_MOEDICT_SHA ? (
          <p className="build-info" style={{ opacity: 0.6, fontSize: "0.85em", marginTop: "1em" }}>
            Build: {import.meta.env.VITE_MOEDICT_SHA}
          </p>
        ) : null}
        <p>
          原始資料來源為教育部《
          <a target="_blank" href="https://dict.revised.moe.edu.tw/" rel="noopener noreferrer">
            重編國語辭典修訂本
          </a>
          》（
          <a
            target="_blank"
            href="https://language.moe.gov.tw/001/Upload/Files/site_content/M0001/respub/dict_reviseddict_download.html"
            rel="noopener noreferrer"
          >
            CC BY-ND 3.0 臺灣
          </a>
          授權）、《
          <a
            target="_blank"
            href="https://sutian.moe.edu.tw/zh-hant/piantsip/pankhuan-singbing/"
            rel="noopener noreferrer"
          >
            臺灣台語常用詞辭典
          </a>
          》（
          <a
            target="_blank"
            href="http://twblg.dict.edu.tw/holodict_new/compile1_6_1.jsp"
            rel="noopener noreferrer"
          >
            CC BY-ND 3.0 臺灣
          </a>
          授權）及《
          <a target="_blank" href="https://hakkadict.moe.edu.tw/" rel="noopener noreferrer">
            臺灣客語辭典
          </a>
          》（
          <a
            target="_blank"
            href="https://hakkadict.moe.edu.tw/directions/%E7%AD%94%E5%AE%A2%E5%95%8F/%E7%89%88%E6%9C%AC%E6%8E%88%E6%AC%8A/"
            rel="noopener noreferrer"
          >
            CC BY-ND 3.0 臺灣
          </a>
          ），辭典本文的著作權仍為教育部所有。
        </p>
        <p>
          筆劃資料來源為教育部「
          <a
            target="_blank"
            href="https://stroke-order.learningweb.moe.edu.tw/"
            rel="noopener noreferrer"
          >
            國字標準字體筆順學習網
          </a>
          」，國語發音資料來源為教育部「
          <a target="_blank" href="https://dict.concised.moe.edu.tw//" rel="noopener noreferrer">
            國語辭典簡編本
          </a>
          」（
          <a
            target="_blank"
            href="https://language.moe.gov.tw/001/Upload/Files/site_content/M0001/respub/dict_concised_download.html"
            rel="noopener noreferrer"
          >
            CC BY-ND 3.0 臺灣
          </a>
          授權），著作權仍為教育部所有。
        </p>
        <p>
          英/法/德文對照表{" "}
          <a target="_blank" href="https://cc-cedict.org/" rel="noopener noreferrer">
            CC-CEDict
          </a>
          、{" "}
          <a
            target="_blank"
            href="https://chine.in/mandarin/dictionnaire/CFDICT/"
            rel="noopener noreferrer"
          >
            CFDict
          </a>
          、{" "}
          <a
            target="_blank"
            href="https://handedict.zydeo.net/en/download"
            rel="noopener noreferrer"
          >
            HanDeDict
          </a>{" "}
          採用{" "}
          <a
            target="_blank"
            href="https://creativecommons.org/licenses/by-sa/4.0/deed.zh_TW"
            rel="noopener noreferrer"
          >
            CC BY-SA 4.0 國際
          </a>
          授權。
        </p>
        <p>
          兩岸詞典由
          <a target="_blank" href="http://www.gacc.org.tw/" rel="noopener noreferrer">
            中華文化總會
          </a>
          提供，採用{" "}
          <a
            target="_blank"
            href="https://creativecommons.org/licenses/by-nc-nd/3.0/tw/deed.zh_TW"
            rel="noopener noreferrer"
          >
            CC BY-NC-ND 3.0 臺灣
          </a>
          授權。
        </p>
        <p>
          歷代書體以內嵌網頁方式，連至
          <a target="_blank" href="http://www.gacc.org.tw/" rel="noopener noreferrer">
            中華文化總會
          </a>
          網站。字體e筆書寫：張炳煌教授。字體選用：郭晉銓博士。
        </p>
        {showWebOnlyActions ? (
          <p className="web-only">
            <a
              target="_blank"
              href="https://play.google.com/store/apps/details?id=org.audreyt.dict.moe"
              rel="noopener noreferrer"
            >
              Android
            </a>
            、{" "}
            <a
              target="_blank"
              href="http://itunes.apple.com/app/id1434947403"
              rel="noopener noreferrer"
            >
              Apple iOS
            </a>{" "}
            及{" "}
            <a
              target="_blank"
              href="https://marketplace.firefox.com/app/%E8%90%8C%E5%85%B8"
              rel="noopener noreferrer"
            >
              Firefox OS
            </a>{" "}
            離線版包含下列第三方元件：
          </p>
        ) : (
          <p>本 App 包含下列第三方元件：</p>
        )}
        <ul>
          <li>
            jQuery 及 jQuery UI 由 jQuery Foundation 提供，採用{" "}
            <a target="_blank" href="https://jquery.org/license/" rel="noopener noreferrer">
              MIT
            </a>{" "}
            授權。
          </li>
          <li>
            Capacitor 由 Ionic 提供，採用{" "}
            <a
              target="_blank"
              href="https://github.com/ionic-team/capacitor/blob/main/LICENSE"
              rel="noopener noreferrer"
            >
              MIT
            </a>{" "}
            授權。
          </li>
          <li>
            Fira Sans 字型由 Mozilla 基金會提供，採用{" "}
            <a
              target="_blank"
              href="https://github.com/mozilla/Fira/blob/master/LICENSE"
              rel="noopener noreferrer"
            >
              SIL Open Font 1.1
            </a>{" "}
            授權。
          </li>
          <li>教育部標準楷書字型由教育部提供，採用可完整轉散佈授權。</li>
        </ul>
        <p>
          <a
            target="_blank"
            href="https://www.moedict.tw/%E5%AD%97%E5%9C%96%E5%88%86%E4%BA%AB"
            rel="noopener noreferrer"
          >
            字圖分享
          </a>
          功能使用下列來源之中文字型：
        </p>
        <ul>
          <li>
            <a
              target="_blank"
              href="http://www.cns11643.gov.tw/AIDB/download.do?name=%E5%AD%97%E5%9E%8B%E4%B8%8B%E8%BC%89"
              rel="noopener noreferrer"
            >
              中文全字庫
            </a>
            採用{" "}
            <a
              target="_blank"
              href="https://creativecommons.org/licenses/by-nd/3.0/tw/deed.zh_TW"
              rel="noopener noreferrer"
            >
              CC BY-ND 3.0 臺灣
            </a>
            授權。
          </li>
          <li>
            <a target="_blank" href="http://www.cl.fcu.edu.tw/" rel="noopener noreferrer">
              逢甲大學中文系
            </a>
            採用「不涉及商業行為使用」授權。
          </li>
          <li>
            <a
              target="_blank"
              href="https://code.google.com/p/cwtex-q-fonts/"
              rel="noopener noreferrer"
            >
              cwTeX Q
            </a>
            採用{" "}
            <a
              target="_blank"
              href="https://www.gnu.org/licenses/old-licenses/gpl-2.0.html"
              rel="noopener noreferrer"
            >
              GPL 2.0
            </a>{" "}
            授權。
          </li>
          <li>
            <a
              target="_blank"
              href="https://github.com/adobe-fonts/source-han-sans/tree/release"
              rel="noopener noreferrer"
            >
              思源黑體
            </a>
            採用{" "}
            <a
              target="_blank"
              href="https://github.com/adobe-fonts/source-han-sans/blob/release/LICENSE.txt"
              rel="noopener noreferrer"
            >
              SIL Open Font 1.1
            </a>
            授權。
          </li>
          <li>
            <a
              target="_blank"
              href="https://github.com/adobe-fonts/source-han-serif/tree/release"
              rel="noopener noreferrer"
            >
              思源宋體
            </a>
            採用{" "}
            <a
              target="_blank"
              href="https://github.com/adobe-fonts/source-han-serif/blob/release/LICENSE.txt"
              rel="noopener noreferrer"
            >
              SIL Open Font 1.1
            </a>
            授權。
          </li>
          <li>
            <a
              target="_blank"
              href="https://code.google.com/p/wangfonts/"
              rel="noopener noreferrer"
            >
              王漢宗自由字型
            </a>
            採用{" "}
            <a
              target="_blank"
              href="https://www.gnu.org/licenses/old-licenses/gpl-2.0.html"
              rel="noopener noreferrer"
            >
              GPL 2.0
            </a>{" "}
            授權。
          </li>
          <li>
            <a
              target="_blank"
              href="http://typography.ascdc.sinica.edu.tw/%E5%AD%97/"
              rel="noopener noreferrer"
            >
              日星初號楷體
            </a>
            採用
            <a
              target="_blank"
              href="https://creativecommons.org/licenses/by-nc-nd/3.0/tw/deed.zh_TW"
              rel="noopener noreferrer"
            >
              CC BY-NC-ND 3.0 臺灣
            </a>
            授權。
          </li>
        </ul>
        <p>
          感謝{" "}
          <a target="_blank" href="http://g0v.tw" rel="noopener noreferrer">
            #g0v.tw
          </a>{" "}
          頻道內所有協助開發的朋友們。
        </p>
        <h2 className="cc0">
          <a
            target="_blank"
            href="https://creativecommons.org/publicdomain/zero/1.0/deed.zh_TW"
            rel="noopener noreferrer"
          >
            CC0 1.0 公眾領域貢獻宣告
          </a>
        </h2>
        <p>
          作者 唐鳳
          在法律許可的範圍內，拋棄此著作依著作權法所享有之權利，包括所有相關與鄰接的法律權利，並宣告將該著作貢獻至公眾領域。
        </p>
      </div>

      {/* 使用說明導覽（#95）：在 /about 內以同頁區段呈現，不新增路由 */}
      <section id="how-to-use" className="content how-to-use">
        <h2>使用說明</h2>
        <p>
          萌典除了基本的字詞查詢，還有許多實用功能。以下整理常用功能與操作方式，部分附上站內範例連結，點擊即可直接體驗：
        </p>
        <ul>
          <li>
            <strong>字詞發音</strong>
            <ul>
              <li>華語、台語、客語皆有發音功能。</li>
              <li>客語包含不同腔調的發音。</li>
            </ul>
            <div className="guide-figures">
              <GuideFigure
                src={guideSrc("發音與表記_resized.jpg")}
                alt="字詞頁的發音按鈕與注音、拼音表記"
                caption="華語、台語發音與表記"
                onOpen={openLightbox}
              />
              <GuideFigure
                src={guideSrc("發音_客語_resized.jpg")}
                alt="客語不同腔調的發音選項"
                caption="客語不同腔調"
                onOpen={openLightbox}
              />
            </div>
          </li>
          <li>
            <strong>多重表記</strong>
            <ul>
              <li>支援拼音、注音，台語與客語另支援方音符號。</li>
            </ul>
            <div className="guide-figures">
              <GuideFigure
                src={guideSrc("多重表記_resized.jpg")}
                alt="拼音、注音與方音符號等多重表記"
                onOpen={openLightbox}
              />
            </div>
          </li>
          <li>
            <strong>部首查詢</strong>
            <ul>
              <li>每個字的部首和筆劃都會列出。</li>
              <li>點擊部首可以查該部首的所有字。</li>
            </ul>
            <div className="guide-figures">
              <GuideFigure
                src={guideSrc("部首查詢_按鈕位置_resized.jpg")}
                alt="字詞頁標示部首與筆劃的位置"
                caption="部首與筆劃位置"
                onOpen={openLightbox}
              />
              <GuideFigure
                src={guideSrc("部首查詢_內頁_resized.jpg")}
                alt="點擊部首後列出該部首所有字"
                caption="點擊部首後的內頁"
                onOpen={openLightbox}
              />
            </div>
          </li>
          <li>
            <strong>部首表</strong>
            <ul>
              <li>
                導覽列選單可以點「<Link to="/@">部首表</Link>」，查到所有部首。
              </li>
            </ul>
            <div className="guide-figures">
              <GuideFigure
                src={guideSrc("部首表_內頁_resized.jpg")}
                alt="從導覽列開啟的部首表頁面"
                onOpen={openLightbox}
              />
            </div>
          </li>
          <li>
            <strong>筆順動畫</strong>
            <ul>
              <li>每個字詞點擊「鉛筆」圖示，可以顯示筆順動畫。</li>
            </ul>
            <div className="guide-figures">
              <GuideFigure
                src={guideSrc("筆順動畫_按鈕_resized.jpg")}
                alt="字詞頁的鉛筆筆順圖示"
                caption="點擊鉛筆圖示"
                onOpen={openLightbox}
              />
              <GuideFigure
                src={guideSrc("筆順動畫_呈現_resized.jpg")}
                alt="筆順動畫播放畫面"
                caption="筆順動畫呈現"
                onOpen={openLightbox}
              />
            </div>
          </li>
          <li>
            <strong>字詞記錄簿</strong>
            <ul>
              <li>
                <Link to="/=*">字詞記錄簿</Link>會自動記錄最近的查詢。
              </li>
              <li>也可以在字詞頁點擊「星星」鍵來加入字詞記錄簿。</li>
            </ul>
            <div className="guide-figures">
              <GuideFigure
                src={guideSrc("字詞記錄簿_內頁_resized.jpg")}
                alt="字詞記錄簿頁面"
                onOpen={openLightbox}
              />
            </div>
          </li>
          <li>
            <strong>萬用字元查詢</strong>
            <ul>
              <li>可用「.」或「?」代表任一字。</li>
              <li>如，在搜尋欄輸入「休.」可以查到「休休」「休假」「休克」「休兵」等兩字詞。</li>
              <li>如，「休..」可以查到「休火山」「休眠期」等三字詞。</li>
            </ul>
            <div className="guide-figures">
              <GuideFigure
                src={guideSrc("萬用字元_resized.jpg")}
                alt="使用萬用字元搜尋的結果"
                onOpen={openLightbox}
              />
            </div>
          </li>
          <li>
            <strong>多語檢索</strong>
            <ul>
              <li>右上角搜尋「cat」可以查到「狸子」「貓」等漢英譯文中含「cat」單字的詞。</li>
            </ul>
            <div className="guide-figures">
              <GuideFigure
                src={guideSrc("多語檢索_resized.jpg")}
                alt="輸入英文進行多語檢索的結果"
                onOpen={openLightbox}
              />
            </div>
          </li>
          <li>
            <strong>發音檢索</strong>
            <ul>
              <li>華語可以搜尋「di」然後找到「的」「第」等。</li>
              <li>台語可以搜尋「kha」然後找到「跤手」「鬥跤手」等。</li>
            </ul>
            <div className="guide-figures">
              <GuideFigure
                src={guideSrc("發音檢索_resized.jpg")}
                alt="輸入拼音進行發音檢索的結果"
                onOpen={openLightbox}
              />
            </div>
          </li>
          <li>
            <strong>字圖生成與鏤空描寫模式</strong>
            <ul>
              <li>
                查詢字典中沒有的字詞，如「<Link to="/萌典是什麼">萌典是什麼</Link>
                」，會出現對應的字圖生成介面。
              </li>
              <li>字圖可以切換成不同的書體，如篆書。</li>
              <li>
                在對應的字圖下方，會有灰色的鏤空字圖，用平板或手機等觸控裝置，可以在上面描寫。
              </li>
            </ul>
            <div className="guide-figures">
              <GuideFigure
                src={guideSrc("字圖生成與鏤空描寫模式_resized.jpg")}
                alt="字圖生成與鏤空描寫介面"
                onOpen={openLightbox}
              />
            </div>
          </li>
          <li>
            <strong>匯出閱讀器可用的字典格式</strong>
            <ul>
              <li>
                <a
                  target="_blank"
                  href="https://github.com/g0v/moedict.tw"
                  rel="noopener noreferrer"
                >
                  萌典專案
                </a>
                的 README 中有說明如何匯出閱讀器可用的字典格式。
              </li>
            </ul>
          </li>
          <li>
            <strong>行動裝置與桌面 App</strong>
            <ul>
              <li>
                有 iOS、macOS、Android App 可安裝，詳見
                <a target="_blank" href="https://www.moedict.tw" rel="noopener noreferrer">
                  萌典網站
                </a>
                。
              </li>
            </ul>
          </li>
        </ul>
      </section>

      {/* GitHub 連結 */}
      {R2_ENDPOINT && (
        <a target="_blank" href="https://github.com/g0v/moedict.tw" rel="noopener noreferrer">
          <img
            style={{ zIndex: 1000, position: "absolute", top: "0px", right: 0, border: 0 }}
            src="/assets/images/right-graphite@2x.png"
            width="120"
            height="120"
            alt="Fork me on GitHub"
          />
        </a>
      )}

      {/* App 版返回按鈕 */}
      <div className="app-only">
        <Link
          to="/"
          title="回到萌典"
          style={{ float: "left", marginTop: "-60px", marginLeft: "5px" }}
          className="visible-xs pull-left ebas btn btn-default home"
        >
          <span className="iconic-circle">
            <SvgIcon
              name="arrowLeft"
              size={12}
              style={{ display: "block", margin: "3px auto" }}
              aria-hidden="true"
            />
          </span>
          <span> 萌典</span>
        </Link>
      </div>

      {/* 下載按鈕 */}
      {showWebOnlyActions && R2_ENDPOINT && (
        <div
          style={{ position: "fixed", bottom: "10px", left: "10px", zIndex: 2 }}
          className="web-only"
        >
          <a
            target="_blank"
            href="https://play.google.com/store/apps/details?id=org.audreyt.dict.moe"
            rel="noopener noreferrer"
          >
            <img
              alt="Google Play 下載"
              title="Google Play 下載"
              src="/images/google_play.jpg"
              width="135"
              height="46"
            />
          </a>
          <a
            target="_blank"
            href="http://itunes.apple.com/app/id1434947403"
            style={{ marginLeft: "10px" }}
            rel="noopener noreferrer"
          >
            <img
              alt="App Store 下載"
              title="App Store 下載"
              src="/images/Download_on_the_App_Store_Badge_HK_TW_135x40.png"
              width="155"
              height="46"
            />
          </a>
        </div>
      )}

      {/* 加入書籤按鈕 */}
      {showWebOnlyActions && (
        <div
          style={{ position: "fixed", bottom: "10px", right: "10px", zIndex: 1 }}
          className="web-only"
        >
          <a
            id="opensearch"
            onClick={async (e) => {
              e.preventDefault();
              const url = window.location.href;
              try {
                await navigator.clipboard.writeText(url);
                setBookmarkHint("已複製網址，請按 Cmd+D (Mac) 或 Ctrl+D (Windows) 加入書籤");
              } catch {
                setBookmarkHint("請按 Cmd+D (Mac) 或 Ctrl+D (Windows) 將此頁加入書籤");
              }
              setTimeout(() => setBookmarkHint(""), 4000);
            }}
            className="btn btn-default btn-info"
            href="#"
            title="將此頁加入瀏覽器書籤"
          >
            <SvgIcon name="plusCircle" size={14} style={{ marginRight: 4 }} aria-hidden="true" />
            加入書籤
          </a>
          {bookmarkHint && (
            <div
              style={{ marginTop: 6, fontSize: 12, color: "var(--color-fg-muted)", maxWidth: 260 }}
            >
              {bookmarkHint}
            </div>
          )}
        </div>
      )}
      {/* 截圖放大檢視（lightbox）#95 */}
      {lightbox && (
        <div
          className="guide-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.alt}
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            className="guide-lightbox-close"
            aria-label="關閉放大檢視"
            onClick={() => setLightbox(null)}
          >
            ×
          </button>
          <img
            className="guide-lightbox-image"
            src={lightbox.src}
            alt={lightbox.alt}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
