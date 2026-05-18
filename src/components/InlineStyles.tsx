/**
 * 內聯樣式組件
 * 注入原專案 page-rendering.tsx 中的內聯樣式
 */

import { useEffect, useState } from 'react';

interface InlineStylesProps {
	r2Endpoint?: string;
	onReady?: () => void;
}

/**
 * 內聯樣式組件
 */
export function InlineStyles({ r2Endpoint, onReady }: InlineStylesProps) {
	const [endpoint, setEndpoint] = useState(r2Endpoint || '');
	const [readyNotified, setReadyNotified] = useState(false);

	useEffect(() => {
		if (r2Endpoint) {
			setEndpoint(r2Endpoint.replace(/\/$/, ''));
		}
	}, [r2Endpoint]);

	useEffect(() => {
		if (!endpoint) {
			// wrangler vars.ASSET_BASE_URL → /api/config.assetBaseUrl
			fetch('/api/config')
				.then((res) => res.json())
				.then((data: { assetBaseUrl?: string }) => {
					if (data.assetBaseUrl) {
						setEndpoint(data.assetBaseUrl.replace(/\/$/, ''));
					} else {
						setEndpoint('/assets');
					}
				})
				.catch(() => {
					setEndpoint('/assets');
				});
		}
	}, [endpoint]);

	useEffect(() => {
		if (endpoint && !readyNotified) {
			onReady?.();
			setReadyNotified(true);
		}
	}, [endpoint, onReady, readyNotified]);

	if (!endpoint) return null;

	return (
		<style
			dangerouslySetInnerHTML={{
				__html: `
		:root {
			--moe-safe-area-top: env(safe-area-inset-top, 0px);
			--moe-safe-area-bottom: env(safe-area-inset-bottom, 0px);
		}

		/* 修正導航列壓版問題 */
		body {
			padding-top: calc(50px + var(--moe-safe-area-top)); /* 為固定導航列 + iOS safe area 留出空間 */
		}

		/* 根版面：給非 fixed 的子元素一個定位參考 */
		.app-shell {
			position: relative;
		}

		/* 偏好設定浮層：緊貼導覽列下緣（含 iOS safe area），避免壓到 navbar */
		#user-pref {
			position: fixed !important;
			top: calc(45px + var(--moe-safe-area-top)) !important;
			z-index: 1050;
			max-height: calc(100vh - 45px - var(--moe-safe-area-top) - var(--moe-safe-area-bottom));
			overflow: auto;
			-webkit-overflow-scrolling: touch;
			box-sizing: border-box;
		}

		/* 確保導航列背景正確顯示 */
		.nav-bg {
			height: 50px;
			padding-top: 0;
			position: fixed;
			top: var(--moe-safe-area-top);
			left: 0;
			right: 0;
			z-index: 1029;
		}

		/* 確保導航列在背景之上 */
		.navbar-fixed-top {
			z-index: 1030;
			top: var(--moe-safe-area-top);
		}

		/* 確保主內容區域不會被左側欄遮擋 */
		#main-content {
			margin-left: 260px;
		}

		/* About 頁面沒有 Sidebar，所以不需要 margin-left */
		#main-content.about-layout {
			margin-left: 0;
		}

		.result {
			padding: 20px;
			margin: 16px;
		}

		@media (max-width: 380px) {
		    body #btn-starred {
			    width: 2.5em !important;
			}
			body #btn-starred i {
				padding-left: .5em !important;
			}
			.nav > li > a {
				padding: 10px 5px !important;
			}
			.nav > .navbar-fulltext-search-item-mobile {
			    width: 3.5em !important;
			    width: -webkit-calc(100vw - 11em) !important;
				width: calc(100vw - 11em) !important;
				right: 2.75em !important;
			}
			.nav > .navbar-fulltext-search-item-mobile input::placeholder {
				color: #999 !important;
			}
		}

		@media only screen and (max-width: 767px) {
			#main-content {
				margin-left: 0;
				margin-top: calc(65px + var(--moe-safe-area-top));
			}

			.document-mobile-search-has-query #main-content {
				/* 預留空間給固定的搜尋框 + 持續顯示的自動聯想 (#112) */
				margin-top: calc(120px + var(--moe-safe-area-top));
			}
		}

		/* 左側欄（query-box）樣式 - 復刻原專案 */
		.query-box {
			width: 260px;
			position: fixed;
			border-right: 1px solid hsl(360, 1%, 83%);
			top: calc(50px + var(--moe-safe-area-top));
			bottom: 0;
			z-index: 9;
			padding: 20px;
			box-sizing: border-box;
			background-color: hsl(0, 0%, 97%);
		}

		@media print {
			.query-box,
			.nav-bg,
			.navbar-fixed-top {
				display: none !important;
			}

			body {
				padding-top: 0 !important;
			}

			#main-content {
				margin-left: 0 !important;
				margin-top: 0 !important;
			}

			/* 字圖列印只保留字形，隱藏詞意說明欄 */
			.charimg-result .moetext td:nth-child(2) {
				display: none !important;
			}

			.charimg-result .moetext {
				max-width: 100% !important;
				margin: 0 auto;
			}
		}

		@media only screen and (max-width: 767px) {
			#query-box.query-box {
				right: auto !important;
				width: 100% !important;
				top: calc(45px + var(--moe-safe-area-top)) !important;
				height: 65px !important;
				bottom: auto !important;
				padding: 15px !important;
				padding-bottom: 3px !important;
				z-index: 11 !important;
				border-right: none !important;
			}

			#main-content {
				margin-left: 0;
			}

			.navbar-nav .open .dropdown-menu {
				width: 100vw !important;
			}

			/* 手機版分類索引：可展開項目在右側顯示白色向下箭頭 */
			.navbar-inverse .navbar-nav .open .dropdown-menu .dropdown-submenu > a.taxonomy {
				position: relative;
				padding-right: 2em;
			}
			.navbar-inverse .navbar-nav .open .dropdown-menu .dropdown-submenu > a.taxonomy:before {
				content: none !important;
			}
			.navbar-inverse .navbar-nav .open .dropdown-menu .dropdown-submenu > a.taxonomy:after {
				content: "\\25BE";
				position: absolute;
				right: 1.6em;
				top: 50%;
				transform: translateY(-50%);
				color: #999;
				font-size: 0.9em;
				line-height: 1;
				pointer-events: none;
			}
		}

		/* Autocomplete 選單樣式 */
		.ui-autocomplete {
			overflow: auto;
			height: auto !important;
			position: fixed !important;
			box-sizing: border-box;
			background: #fff;
			border: 1px solid #ddd;
			border-radius: 4px;
			box-shadow: 0 2px 8px rgba(0,0,0,0.15);
		}

		.ui-autocomplete.search-results {
			list-style: none;
			margin: 8px 0 0;
			padding: 0;
			display: block !important;
			visibility: visible !important;
			position: fixed !important;
			z-index: 1200 !important;
		}

		.ui-autocomplete.search-results .ui-menu-item {
			padding: 1px;
			cursor: pointer;
			border-bottom: 1px solid #eee;
		}

		.ui-autocomplete.search-results .ui-menu-item:hover a,
		.ui-autocomplete.search-results .ui-menu-item a:focus {
			outline: none;
			margin: -1px;
			border: 1px solid #74b2e2;
			background: #e4f1fb;
			color: #0070a3;
		}

		.ui-autocomplete.search-results .ui-menu-item a,
		.ui-autocomplete.search-results .ui-menu-item span {
			display: block;
			color: #333;
			text-decoration: none;
			font-weight: 400;
		}

		.ui-autocomplete.search-results .ui-menu-item.is-status {
			cursor: default;
			color: #666;
		}

		.ui-autocomplete.search-results .ui-menu-item:not(.is-status):hover {
			background: #f0f0f0;
		}

		@media only screen and (min-width: 768px) {
			.ui-autocomplete.search-results {
				top: 113px !important;
				bottom: auto !important;
				left: 19px !important;
				width: 221px !important;
				max-height: 80% !important;
			}
		}

		@media only screen and (max-width: 767px) {
			.ui-autocomplete.search-results {
				top: 145px !important;
				height: auto !important;
				max-height: 68vh !important;
				left: 15px !important;
				right: 15px !important;
				width: auto !important;
				position: fixed !important;
				z-index: 2200 !important;
			}
		}

		/* 搜尋輸入框樣式 */
		.query-box input.query {
			display: block;
			border: 1px solid #ddd;
			font-size: 1.2em;
			width: 100%;
			height: 1.8em;
			box-sizing: border-box;
			padding: 4px 8px;
		}

		.query-box input.query::placeholder {
			font-size: 0.7em;
		}

		.query-box .search-form {
			width: 100%;
			flex: 1 1 auto;
			min-width: 0;
		}

		.query-box .mobile-search-bar {
			display: flex;
			align-items: center;
			gap: 8px;
			width: 100%;
		}

		.query-box .search-input-wrap {
			position: relative;
		}

		.query-box input.query {
			padding-right: 34px;
		}

		.query-box .mobile-search-back {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			flex: 0 0 18px;
			width: 18px;
			height: 34px;
			padding: 0;
			border: 0;
			background: transparent;
		}

		.query-box .mobile-search-back-chevron {
			width: 14px;
			height: 14px;
			border-left: 5px solid #990012;
			border-bottom: 5px solid #990012;
			border-radius: 2px;
			transform: rotate(45deg);
		}

		.query-box .mobile-search-clear {
			position: absolute;
			right: 8px;
			top: 50%;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 22px;
			height: 22px;
			padding: 0;
			border: 0;
			border-radius: 50%;
			background: #bfc0c2;
			color: #fff;
			font-size: 21px;
			font-weight: 700;
			line-height: 1;
			transform: translateY(-50%);
		}

		.query-box .mobile-search-toggle {
			display: none;
			width: 100%;
			text-align: left;
			border: 1px solid #d6d6d8;
			border-radius: 8px;
			background: #f3f3f5;
			color: #3b3140;
			padding: 8px 12px;
			line-height: 1.3;
			align-items: center;
		}

		.query-box .mobile-search-toggle-arrow {
			margin-right: 8px;
			font-size: 1.2em;
		}

		@media only screen and (max-width: 767px) {
			.query-box .mobile-search-bar {
				display: flex;
				align-items: center;
				gap: 12px;
				width: 100%;
			}

			.query-box .mobile-search-back {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				flex: 0 0 40px;
				width: 40px;
				height: 40px;
				padding: 0;
				border: 0;
				background: transparent;
			}

			.query-box .mobile-search-back-chevron {
				width: 20px;
				height: 20px;
				border-left: 7px solid #990012;
				border-bottom: 7px solid #990012;
				border-radius: 3px;
				transform: rotate(45deg);
			}

			.query-box .search-form {
				flex: 1 1 auto;
				min-width: 0;
			}

			.query-box input.query {
				height: 44px;
				border-radius: 5px;
				padding-right: 44px;
			}

			.query-box input.query::placeholder {
				font-size: 1em;
			}

			.query-box .mobile-search-clear {
				right: 10px;
				width: 25px;
				height: 25px;
				font-size: 24px;
			}

			.query-box .mobile-search-toggle {
				display: flex;
				margin-top: 12px;
				font-size: 1.05em;
			}
		}

		/* 隱藏搜尋輸入框的取消按鈕 */
		::-webkit-search-cancel-button {
			-webkit-appearance: none;
		}

		/* 手機版調整 */
		@media (max-width: 767px) {
			body {
				padding-top: 0;
			}

			.nav-bg {
				position: static;
			}

			/* 手機版導覽下緣以 50px 對齊，避免與 #main-content 跑版 */
			#user-pref {
				top: calc(50px + var(--moe-safe-area-top)) !important;
				max-height: calc(100vh - 50px - var(--moe-safe-area-top) - var(--moe-safe-area-bottom));
			}
		}

		/* 字典發音按鈕（複刻原專案） */
		.part-of-speech.playAudio {
			color: #6B0000;
			background: transparent;
			font-size: 90%;
			padding: 0;
			cursor: pointer;
			line-height: 100%;
			display: inline-block;
		}
		.audioBlock {
			display: inline-block;
			margin-left: 8px;
			font-size: 70% !important;
		}
		.playAudio {
			margin-left: 5px;
			color: #6B0000;
			font-size: 70%;
			padding-left: 5px;
			display: inline-block !important;
		}

		/* 外文翻譯 TTS 可點擊 */
		.fw_def {
			cursor: pointer;
		}
		.fw_def:hover {
			text-decoration: underline;
		}

		/* 偏好設定：主音標區塊跟隨 body[data-ruby-pref] */
		.main-pronunciation .bpmf {
			display: inline-block;
		}
		.main-pronunciation .pinyin {
			display: inline-block;
		}
		body[data-ruby-pref='pinyin'] .main-pronunciation .bpmf,
		body[data-ruby-pref='none'] .main-pronunciation .bpmf {
			display: none;
		}
		body[data-ruby-pref='zhuyin'] .main-pronunciation .pinyin,
		body[data-ruby-pref='none'] .main-pronunciation .pinyin {
			display: none;
		}
		body[data-ruby-pref='none'] .main-pronunciation {
			display: none;
		}

		/* 部首頁與 Tooltip 對齊原專案 */
		.stroke-list .stroke-char {
			margin-right: 6px;
			text-decoration: none;
		}
		.stroke-list .stroke-char:hover {
			text-decoration: none;
		}
		.ui-tooltip {
			max-width: 360px;
			overflow: auto !important;
			padding: 8px 12px;
		}
			.ui-tooltip .title .h1,
			.ui-tooltip .title h1 {
				font-family: "Biaodian Pro Serif CNS", "Numeral LF Serif", "MOEDICT", "Fira Sans OT", "Georgia", "Times New Roman", "Zhuyin Kaiti", "TW-Kai-98_1", "教育部標準楷書", "kai-pc", "CMEXc1", "BiauKai", "MOEDICT-IOS-KAI", "DFKaiShu-SB-Estd-BF", "全字庫正楷體", "Kaiti TC", "楷體-繁", "文鼎ＰＬ新中楷", "cwText 楷書", cursive, serif, "HanaMinA", "HanaMinB", "HAN NOM A", "HAN NOM B", "Han Kaiti CNS", cursive, serif !important;
				font-size: 30px !important;
				line-height: 2 !important;
				font-weight: 501 !important;
				margin: -0.25em 0 0.5em !important;
				padding-bottom: 0.3em !important;
				border-bottom: none !important;
				color: #000 !important;
			}
			.ui-tooltip .title .h1 a,
			.ui-tooltip .title h1 a,
			.ui-tooltip .stroke-list .stroke-char {
				font-family: inherit !important;
				font-size: inherit !important;
				text-decoration: none !important;
				color: #000 !important;
			}
		.ui-tooltip .title .h1 a:hover,
		.ui-tooltip .title h1 a:hover,
		.ui-tooltip .stroke-list .stroke-char:hover {
			text-decoration: none !important;
		}
		.ui-tooltip .stroke-list {
			display: inline-flex;
			flex-wrap: wrap;
			gap: 6px;
		}
		.ui-tooltip .entry-item {
			margin-top: 8px;
		}
		.ui-tooltip .entry-item .part-of-speech {
			margin-right: 4px;
		}
		.ui-tooltip .entry-item ol {
			margin: .4em 0 0 20px;
			padding-top: 1em;
		}
		`
			}}
		/>
	);
}
