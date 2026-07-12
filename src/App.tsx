import { useEffect, useRef, useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  useLocation,
  useNavigationType,
  Outlet,
  Navigate,
} from "react-router-dom";
import { About } from "./pages/About";
import { Privacy } from "./pages/Privacy";
import { RadicalView } from "./pages/RadicalView";
import { MiddlePoint } from "./MiddlePoint";
import { DictionaryA } from "./pages/Dictionary-a";
import { Layout } from "./components/Layout";
import { readLastLookup } from "./utils/word-record-utils";
import {
  disableNativeScrollRestoration,
  getSavedScrollPosition,
  restoreScrollPosition,
  saveScrollPosition,
} from "./utils/scroll-position";
import { applyHeadByPath } from "./ssr/head";
import "./App.css";

/**
 * Normal Layout 包裝器
 */
function NormalLayout() {
  const [r2Endpoint, setR2Endpoint] = useState<string>("");

  useEffect(() => {
    // wrangler vars.ASSET_BASE_URL → /api/config.assetBaseUrl
    fetch("/api/config")
      .then((res) => res.json())
      .then((data: { assetBaseUrl?: string }) => {
        if (data.assetBaseUrl) {
          const endpoint = data.assetBaseUrl.replace(/\/$/, "");
          setR2Endpoint(endpoint);
        }
      })
      .catch((err) => {
        console.error("取得 ASSET_BASE_URL 失敗:", err);
      });
  }, []);

  return (
    <Layout layout="normal" r2Endpoint={r2Endpoint}>
      <Outlet />
    </Layout>
  );
}

/**
 * About Layout 包裝器
 */
function AboutLayout() {
  const [r2Endpoint, setR2Endpoint] = useState<string>("");

  useEffect(() => {
    // wrangler vars.ASSET_BASE_URL → /api/config.assetBaseUrl
    fetch("/api/config")
      .then((res) => res.json())
      .then((data: { assetBaseUrl?: string }) => {
        if (data.assetBaseUrl) {
          const endpoint = data.assetBaseUrl.replace(/\/$/, "");
          setR2Endpoint(endpoint);
        }
      })
      .catch((err) => {
        console.error("取得 ASSET_BASE_URL 失敗:", err);
      });
  }, []);

  return (
    <Layout layout="about" r2Endpoint={r2Endpoint}>
      <Outlet />
    </Layout>
  );
}

/**
 * 路由切換時管理捲動位置。
 *
 * 「前進」導航（PUSH / REPLACE，例如點擊連結進入新頁面）一律捲動至頁面頂端。
 *
 * 瀏覽器倒退／前進（POP，例如按下上一頁）則自行還原離開該頁時記錄的捲動位置，
 * 不依賴瀏覽器原生的 `history.scrollRestoration = "auto"`：萌典的詞語列表頁
 * （例如 /=成語）內容量大，重新渲染到完整高度需要一段時間，瀏覽器原生機制只
 * 會在 popstate 當下嘗試還原一次，若那時內容還沒撐開，捲動位置就會被夾在當下
 * 可捲動的最大值，之後即使內容長高了也不會再重試（見
 * g0v/moedict-webkit#102）。因此改用 `disableNativeScrollRestoration` 關閉
 * 瀏覽器的一次性嘗試，並以 `restoreScrollPosition` 輪詢等待內容長到足夠高度
 * 後再還原；捲動位置則由每次捲動時透過 `saveScrollPosition` 依 history entry
 * 的 `location.key` 記錄下來。
 */
function ScrollToTop() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const restoringRef = useRef(false);

  useEffect(disableNativeScrollRestoration, []);

  useEffect(() => {
    if (navigationType === "POP") {
      const saved = getSavedScrollPosition(location.key);
      if (typeof saved === "number") {
        restoringRef.current = true;
        restoreScrollPosition(saved, () => {
          restoringRef.current = false;
        });
      }
      return;
    }
    window.scrollTo(0, 0);
  }, [location.pathname, location.key, navigationType]);

  useEffect(() => {
    let ticking = false;
    const handleScroll = () => {
      if (restoringRef.current) return;
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        if (!restoringRef.current) saveScrollPosition(location.key, window.scrollY);
        ticking = false;
      });
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [location.key]);

  return null;
}

function HeadManager() {
  const location = useLocation();

  useEffect(() => {
    applyHeadByPath(location.pathname);
  }, [location.pathname]);

  return null;
}

/**
 * URL 解碼組件：監聽 URL 變化，當發現被編碼時自動還原
 * 注意：主要的攔截邏輯已經在 main.tsx 中設置，這裡只處理路由變化後的檢查
 */
function URLDecoder() {
  const location = useLocation();

  useEffect(() => {
    // 當路由變化時，檢查並修正 URL（作為備用機制）
    const currentPath = window.location.pathname;

    if (currentPath.includes("%")) {
      try {
        const decoded = decodeURIComponent(currentPath);
        if (decoded !== currentPath) {
          // 使用 replaceState 避免在歷史記錄中留下編碼的 URL
          window.history.replaceState(null, "", decoded);
        }
      } catch (e) {
        console.warn("URL 解碼失敗:", e);
      }
    }
  }, [location.pathname]);

  return null;
}

function formatWordPath(word: string, lang: "a" | "t" | "h" | "c"): string {
  if (!word) return "/萌";
  if (lang === "t") return `/'${word}`;
  if (lang === "h") return `/:${word}`;
  if (lang === "c") return `/~${word}`;
  return `/${word}`;
}

function HomeRoute() {
  const lastLookup = readLastLookup();
  if (!lastLookup) {
    return <DictionaryA word="萌" />;
  }
  return <Navigate to={formatWordPath(lastLookup.word, lastLookup.lang)} replace />;
}

function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <HeadManager />
      <URLDecoder />
      <Routes>
        {/* Privacy 頁面：獨立顯示，無導覽列 */}
        <Route path="/privacy" element={<Privacy />} />

        {/* About 頁面使用 about layout */}
        <Route element={<AboutLayout />}>
          <Route path="/about" element={<About />} />
          <Route path="/about.html" element={<About />} />
        </Route>

        {/* 其他頁面使用 normal layout */}
        <Route element={<NormalLayout />}>
          {/* 首頁路由 */}
          <Route path="/" element={<HomeRoute />} />

          {/* 部首表（唯一合法的純靜態 segment） */}
          <Route path="/@" element={<RadicalView lang="a" />} />
          <Route path="/~@" element={<RadicalView lang="c" />} />
          <Route path="/'@" element={<RadicalView lang="t" />} />

          {/* 其他路由交由 MiddlePoint 分流 */}
          <Route path="*" element={<MiddlePoint />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
