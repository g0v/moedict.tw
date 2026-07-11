import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { M3eDialog } from '@m3e/react/dialog';
import { M3eButton } from '@m3e/react/button';
import { M3eIconButton } from '@m3e/react/icon-button';
import {
	FONT_SIZE_MAX_PT,
	FONT_SIZE_MIN_PT,
	applyFontSize,
	clampFontSize,
	readFontSize,
	writeFontSize,
} from '../utils/font-size-utils';
import { M3eIcon } from '@m3e/react/icon';

type Lang = 'a' | 't' | 'h' | 'c';
type PrefKey = 'phonetics' | 'pinyin_a' | 'pinyin_t' | 'pinyin_h';

interface PrefOption {
	value: string;
	label: string;
	divider?: boolean;
}


const PHONETICS_OPTIONS: PrefOption[] = [
	{ value: 'rightangle', label: '注音拼音共同顯示' },
	{ value: 'bopomofo', label: '注音符號' },
	{ value: 'pinyin', label: '羅馬拼音' },
	{ value: '-', label: '', divider: true },
	{ value: 'none', label: '關閉' },
];

const PINYIN_A_OPTIONS: PrefOption[] = [
	{ value: 'HanYu-TongYong', label: '漢語華通共同顯示' },
	{ value: 'HanYu', label: '漢語拼音' },
	{ value: 'TongYong', label: '華通拼音' },
	{ value: 'WadeGiles', label: '威妥瑪式' },
	{ value: 'GuoYin', label: '注音二式' },
];

const PINYIN_T_OPTIONS: PrefOption[] = [
	{ value: 'TL-DT', label: '臺羅臺通共同顯示' },
	{ value: 'TL', label: '臺羅拼音' },
	{ value: 'DT', label: '臺通拼音' },
	{ value: 'POJ', label: '白話字' },
];

const PINYIN_H_OPTIONS: PrefOption[] = [
	{ value: 'TH', label: '客家語拼音方案' },
	{ value: 'PFS', label: '客語白話字' },
];

function inferLangFromPath(pathname: string): Lang {
	if (pathname.startsWith("/'")) return 't';
	if (pathname.startsWith('/:')) return 'h';
	if (pathname.startsWith('/~')) return 'c';
	return 'a';
}

function getStoredPref(key: string, fallback: string): string {
	try {
		const value = window.localStorage.getItem(key);
		return value || fallback;
	} catch {
		return fallback;
	}
}

function setStoredPref(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// ignore localStorage write errors
	}
}

/**
 * 偏好設定面板開關事件：改用 CustomEvent + UserPref 內部 state 控制
 * <m3e-dialog> 的 open。舊版 jQuery slideToggle/slideUp 從未真正生效
 * （AssetLoader 未載入 jQuery），這裡直接改為純事件通知，行為等價。
 */
const USER_PREF_TOGGLE_EVENT = 'moe:user-pref-toggle';

function applyPhoneticsBodyAttr(value: string): void {
	const mapped = {
		rightangle: 'both',
		bopomofo: 'zhuyin',
		pinyin: 'pinyin',
		none: 'none',
	}[value] || 'both';
	document.body.setAttribute('data-ruby-pref', mapped);
}

// eslint-disable-next-line react-refresh/only-export-components
export function toggleUserPrefPanel(): void {
	window.dispatchEvent(new CustomEvent(USER_PREF_TOGGLE_EVENT));
}

function PrefList({
	name,
	label,
	options,
	value,
	onChange,
}: {
	name: PrefKey;
	label: string;
	options: PrefOption[];
	value: string;
	onChange: (nextValue: string) => void;
}) {
	const activeValue = useMemo(() => {
		const hasValue = options.some((option) => !option.divider && option.value === value);
		if (hasValue) return value;
		return options.find((option) => !option.divider)?.value || '';
	}, [options, value]);

	return (
		<li className="btn-group" id={`pref-${name}`}>
			<label htmlFor={`pref-select-${name}`}>{label}</label>
			<select
				id={`pref-select-${name}`}
				className="form-control input-sm"
				value={activeValue}
				onChange={(event) => onChange(event.target.value)}
			>
				{options.map((option) =>
					option.divider ? (
						<option key={`${name}-divider`} disabled>
							---------
						</option>
					) : (
						<option key={`${name}-${option.value}`} value={option.value}>
							{option.label}
						</option>
					)
				)}
			</select>
		</li>
	);
}

export function UserPref() {
	const location = useLocation();
	const currentLang = inferLangFromPath(location.pathname);
	const [open, setOpen] = useState(false);
	const [phonetics, setPhonetics] = useState(() => getStoredPref('phonetics', 'rightangle'));
	const [pinyinA, setPinyinA] = useState(() => getStoredPref('pinyin_a', 'HanYu'));
	const [pinyinT, setPinyinT] = useState(() => getStoredPref('pinyin_t', 'TL'));
	const [pinyinH, setPinyinH] = useState(() => getStoredPref('pinyin_h', 'TH'));
	const [fontSize, setFontSize] = useState<number>(() => readFontSize());

	useEffect(() => {
		const onToggle = () => setOpen((current) => !current);
		window.addEventListener(USER_PREF_TOGGLE_EVENT, onToggle);
		return () => window.removeEventListener(USER_PREF_TOGGLE_EVENT, onToggle);
	}, []);

	useEffect(() => {
		const classList = document.body.classList;
		classList.remove('lang-a', 'lang-t', 'lang-h', 'lang-c');
		classList.add(`lang-${currentLang}`);
		return () => {
			classList.remove(`lang-${currentLang}`);
		};
	}, [currentLang]);

	useEffect(() => {
		applyPhoneticsBodyAttr(phonetics);
		setStoredPref('phonetics', phonetics);
	}, [phonetics]);

	useEffect(() => {
		applyFontSize(fontSize);
	}, [fontSize]);

	const closePanel = useCallback(() => {
		setOpen(false);
	}, []);

	const adjustFontSize = useCallback((offset: number) => {
		setFontSize((current) => writeFontSize(clampFontSize(current) + offset));
	}, []);

	return (
		// id is deliberately NOT "user-pref": the legacy remote theme
		// (data/assets/styles.css) has `#user-pref { display: none; ... }`
		// as its default (the old div-panel toggled visible via an inline
		// style). That ID-selector rule has higher specificity than this
		// component's own `:host { display: contents }` default and would
		// silently keep the dialog display:none forever, regardless of its
		// `open` state — confirmed via computed-style inspection, the
		// dialog was promoted to the top layer (`:modal` matched) but
		// still invisible. Use a namespaced id to avoid the collision.
		<M3eDialog id="m3-user-pref" open={open} dismissible onClosed={closePanel} onCancel={closePanel}>
			<span slot="header">偏好設定</span>
			<ul>
				{currentLang === 'a' && (
					<PrefList
						name="pinyin_a"
						label="羅馬拼音顯示方式"
						options={PINYIN_A_OPTIONS}
						value={pinyinA}
						onChange={(nextValue) => {
							setStoredPref('pinyin_a', nextValue);
							setPinyinA(nextValue);
							window.location.reload();
						}}
					/>
				)}
				{currentLang === 't' && (
					<PrefList
						name="pinyin_t"
						label="羅馬拼音顯示方式"
						options={PINYIN_T_OPTIONS}
						value={pinyinT}
						onChange={(nextValue) => {
							setStoredPref('pinyin_t', nextValue);
							setPinyinT(nextValue);
							window.location.reload();
						}}
					/>
				)}
				{currentLang === 'h' && (
					<PrefList
						name="pinyin_h"
						label="四縣客語顯示方式"
						options={PINYIN_H_OPTIONS}
						value={pinyinH}
						onChange={(nextValue) => {
							setStoredPref('pinyin_h', nextValue);
							setPinyinH(nextValue);
							window.location.reload();
						}}
					/>
				)}
				<PrefList
					name="phonetics"
					label="條目音標顯示方式"
					options={PHONETICS_OPTIONS}
					value={phonetics}
					onChange={setPhonetics}
				/>
				<li className="btn-group" id="pref-font-size">
					<label htmlFor="pref-font-size-dec">字體大小</label>
					<span className="font-size-controls">
						<M3eIconButton
							id="pref-font-size-dec"
							variant="outlined"
							onClick={() => adjustFontSize(-1)}
							disabled={fontSize <= FONT_SIZE_MIN_PT}
							aria-label="縮小字體"
						>
							<M3eIcon name="text_decrease" title="縮小字體" />
						</M3eIconButton>
						<span className="font-size-current" aria-live="polite">{fontSize}pt</span>
						<M3eIconButton
							variant="outlined"
							onClick={() => adjustFontSize(1)}
							disabled={fontSize >= FONT_SIZE_MAX_PT}
							aria-label="放大字體"
						>
							<M3eIcon name="text_increase" title="放大字體" />
						</M3eIconButton>
					</span>
				</li>
			</ul>
			<div slot="actions" {...{ end: true }}>
				<M3eButton variant="filled" onClick={closePanel}>
					關閉
				</M3eButton>
			</div>
		</M3eDialog>
	);
}
